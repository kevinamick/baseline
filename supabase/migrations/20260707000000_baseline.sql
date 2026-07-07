-- Baseline schema (squashed from the 46 pre-launch migrations, 2026-07-07).
-- Generated with `supabase db dump --local` against the fully-migrated database,
-- then the imperative pieces a schema dump cannot carry are re-appended below:
--   * pgmq queue creation (eval_runs)
--   * the five pg_cron jobs
--   * the auth.users sign-up trigger (lives outside the dumped schemas)
-- End-state equivalence with the old chain was verified by dumping schema, cron
-- jobs, and queues before and after a `db reset` and diffing.




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgmq";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."eval_run_status" AS ENUM (
    'queued',
    'running',
    'completed',
    'failed',
    'skipped'
);


ALTER TYPE "public"."eval_run_status" OWNER TO "postgres";


CREATE TYPE "public"."evaluation_mode" AS ENUM (
    'conversational',
    'prompt_response'
);


ALTER TYPE "public"."evaluation_mode" OWNER TO "postgres";


CREATE TYPE "public"."optimization_run_status" AS ENUM (
    'queued',
    'running',
    'paused',
    'completed',
    'failed'
);


ALTER TYPE "public"."optimization_run_status" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accrue_managed_spend"("p_org_id" "uuid", "p_amount_usd" numeric, "p_provider" "text", "p_model" "text", "p_input_tokens" bigint, "p_output_tokens" bigint, "p_input_unit_usd" numeric, "p_output_unit_usd" numeric, "p_markup_pct" numeric, "p_call_kind" "text", "p_eval_run_id" "uuid" DEFAULT NULL::"uuid", "p_opt_run_id" "uuid" DEFAULT NULL::"uuid") RETURNS numeric
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ps timestamptz;
  v_pe timestamptz;
begin
  if num_nonnulls(p_eval_run_id, p_opt_run_id) <> 1 then
    raise exception 'accrue_managed_spend: exactly one run id required';
  end if;

  if p_eval_run_id is not null then
    select period_start, period_end into v_ps, v_pe
    from point_ledger
    where eval_run_id = p_eval_run_id and entry_type = 'reserve'
    limit 1;
  else
    select period_start, period_end into v_ps, v_pe
    from optimization_run_ledger
    where opt_run_id = p_opt_run_id and entry_type = 'reserve'
    limit 1;
  end if;

  if v_ps is null then
    raise exception 'accrue_managed_spend: no platform reserve found for run';
  end if;

  insert into managed_spend_ledger
    (org_id, entry_type, amount_usd, eval_run_id, opt_run_id,
     provider, model, input_tokens, output_tokens,
     input_unit_usd, output_unit_usd, markup_pct, call_kind,
     period_start, period_end)
  values
    (p_org_id, 'accrue', p_amount_usd, p_eval_run_id, p_opt_run_id,
     p_provider, p_model, p_input_tokens, p_output_tokens,
     p_input_unit_usd, p_output_unit_usd, p_markup_pct, p_call_kind,
     v_ps, v_pe);

  -- Keep the invoice mirror current (#186). Incremental add equals re-summing
  -- the immutable accrue rows; re-marks the line dirty for the next push.
  if p_provider is not null and p_model is not null then
    insert into managed_invoice_lines
      (org_id, period_start, period_end, provider, model, accrued_usd, unit_markup_pct, dirty)
    values
      (p_org_id, v_ps, v_pe, p_provider, p_model, p_amount_usd, p_markup_pct, true)
    on conflict (org_id, period_start, provider, model) do update
      set accrued_usd     = managed_invoice_lines.accrued_usd + excluded.accrued_usd,
          unit_markup_pct = excluded.unit_markup_pct,
          dirty           = true,
          updated_at      = now();
  end if;

  return public.managed_spend_total(p_org_id, v_ps);
end;
$$;


ALTER FUNCTION "public"."accrue_managed_spend"("p_org_id" "uuid", "p_amount_usd" numeric, "p_provider" "text", "p_model" "text", "p_input_tokens" bigint, "p_output_tokens" bigint, "p_input_unit_usd" numeric, "p_output_unit_usd" numeric, "p_markup_pct" numeric, "p_call_kind" "text", "p_eval_run_id" "uuid", "p_opt_run_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ack_eval_run_message"("p_msg_id" bigint) RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select pgmq.delete('eval_runs', p_msg_id);
$$;


ALTER FUNCTION "public"."ack_eval_run_message"("p_msg_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_access_code"("p_code" "text") RETURNS TABLE("claimed" boolean, "status" "text", "access_code_id" "uuid", "trial_days" integer, "stripe_coupon_id" "text", "plan_slug" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_id      uuid;
  v_max     integer;
  v_count   integer;
  v_expires timestamptz;
  v_trial   integer;
  v_coupon  text;
  v_plan    text;
begin
  select ac.id, ac.max_redemptions, ac.redeemed_count, ac.expires_at,
         ac.trial_days, ac.stripe_coupon_id, ac.plan_slug
    into v_id, v_max, v_count, v_expires, v_trial, v_coupon, v_plan
  from access_codes ac
  where lower(ac.code) = lower(p_code)
  for update;

  if not found then
    return query select false, 'not_found'::text, null::uuid, null::integer, null::text, null::text;
    return;
  end if;

  if v_expires is not null and v_expires < now() then
    return query select false, 'expired'::text, v_id, v_trial, v_coupon, v_plan;
    return;
  end if;

  if v_count >= v_max then
    return query select false, 'exhausted'::text, v_id, v_trial, v_coupon, v_plan;
    return;
  end if;

  update access_codes
  set redeemed_count = redeemed_count + 1
  where id = v_id
    and redeemed_count < max_redemptions;

  if not found then
    -- Shouldn't be reachable given the row lock above; guards against any
    -- isolation-level surprise rather than trusting FOR UPDATE alone.
    return query select false, 'exhausted'::text, v_id, v_trial, v_coupon, v_plan;
    return;
  end if;

  return query select true, 'claimed'::text, v_id, v_trial, v_coupon, v_plan;
end;
$$;


ALTER FUNCTION "public"."claim_access_code"("p_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."compute_next_run_at"("p_frequency" "text", "p_local_hour" smallint, "p_days_of_week" smallint[], "p_day_of_month" smallint, "p_timezone" "text", "p_after" timestamp with time zone DEFAULT "now"()) RETURNS timestamp with time zone
    LANGUAGE "plpgsql" STABLE
    AS $$
declare
  v_local      timestamp;            -- wall-clock local time of p_after
  v_cand_local timestamp;
  v_hour       int := coalesce(p_local_hour, 0);
  i            int;
  v_dow        int;
begin
  -- Hourly fires at minute :00 of every hour; tz is irrelevant at minute 0.
  if p_frequency = 'hourly' then
    return date_trunc('hour', p_after) + interval '1 hour';
  end if;

  v_local := p_after at time zone p_timezone;

  if p_frequency = 'daily' then
    v_cand_local := date_trunc('day', v_local) + make_interval(hours => v_hour);
    if v_cand_local <= v_local then
      v_cand_local := v_cand_local + interval '1 day';
    end if;
    return v_cand_local at time zone p_timezone;

  elsif p_frequency = 'weekly' then
    -- Scan today..+7 days for the soonest selected weekday whose time is still ahead.
    for i in 0..7 loop
      v_cand_local := date_trunc('day', v_local) + make_interval(days => i, hours => v_hour);
      v_dow := extract(isodow from v_cand_local)::int;
      if v_dow = any(coalesce(p_days_of_week, '{}'::smallint[])) and v_cand_local > v_local then
        return v_cand_local at time zone p_timezone;
      end if;
    end loop;
    return null;  -- no days selected

  elsif p_frequency = 'monthly' then
    v_cand_local := date_trunc('month', v_local)
                    + make_interval(days => coalesce(p_day_of_month, 1) - 1, hours => v_hour);
    if v_cand_local <= v_local then
      v_cand_local := (date_trunc('month', v_local) + interval '1 month')
                      + make_interval(days => coalesce(p_day_of_month, 1) - 1, hours => v_hour);
    end if;
    return v_cand_local at time zone p_timezone;
  end if;

  return null;
end;
$$;


ALTER FUNCTION "public"."compute_next_run_at"("p_frequency" "text", "p_local_hour" smallint, "p_days_of_week" smallint[], "p_day_of_month" smallint, "p_timezone" "text", "p_after" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."connections_delete_secret"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'vault', 'pg_temp'
    AS $$
begin
  if old.auth_secret_id is not null then
    delete from vault.secrets where id = old.auth_secret_id;
  end if;
  return old;
end;
$$;


ALTER FUNCTION "public"."connections_delete_secret"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_connection_secret"("p_secret" "text", "p_name" "text") RETURNS "uuid"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'vault', 'pg_temp'
    AS $$
  select vault.create_secret(p_secret, p_name);
$$;


ALTER FUNCTION "public"."create_connection_secret"("p_secret" "text", "p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dashboard_runs"("p_org_id" "uuid", "p_window_start" timestamp with time zone, "p_n" integer DEFAULT 10) RETURNS TABLE("id" "uuid", "rubric_id" "uuid", "status" "public"."eval_run_status", "overall_score" numeric, "created_at" timestamp with time zone, "run_no" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with numbered as (
    select
      r.id, r.rubric_id, r.status, r.overall_score, r.created_at,
      r.status = 'completed' and r.overall_score is not null as scored,
      row_number() over (partition by r.rubric_id
                         order by r.created_at)      as run_no,
      row_number() over (partition by r.rubric_id
                         order by r.created_at desc) as rev_no,
      row_number() over (partition by r.rubric_id,
                                      (r.status = 'completed' and r.overall_score is not null)
                         order by r.created_at desc) as grp_rev_no
    from public.eval_runs r
    join public.rubrics rb on rb.id = r.rubric_id
    where rb.org_id = p_org_id
      and r.deleted_at is null
  )
  select id, rubric_id, status, overall_score, created_at, run_no
  from numbered
  where created_at >= p_window_start
     or rev_no <= p_n
     or (scored and grp_rev_no <= 4) -- last 4 scored runs (focus card shows 4)
  order by created_at;
$$;


ALTER FUNCTION "public"."dashboard_runs"("p_org_id" "uuid", "p_window_start" timestamp with time zone, "p_n" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_connection_secret"("p_secret_id" "uuid") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'vault', 'pg_temp'
    AS $$
  delete from vault.secrets where id = p_secret_id;
$$;


ALTER FUNCTION "public"."delete_connection_secret"("p_secret_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dequeue_eval_run_message"("vt_seconds" integer DEFAULT 60) RETURNS TABLE("msg_id" bigint, "run_id" "uuid")
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select m.msg_id, (m.message->>'runId')::uuid as run_id
  from pgmq.read('eval_runs', vt_seconds, 1) m;
$$;


ALTER FUNCTION "public"."dequeue_eval_run_message"("vt_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_min_one_admin"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  remaining int;
begin
  -- Non-admin rows, and admin updates that stay admin, can't violate it.
  if old.role <> 'admin' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and new.role = 'admin' then
    return new;
  end if;

  -- Exempt cascade deletes. Deleting an organization, or a user, legitimately
  -- removes its membership rows (incl. the last admin); the invariant only
  -- guards *direct*, app-driven changes where both the org and the user remain.
  -- During a cascade the parent row is already gone within this transaction.
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.organizations where id = old.org_id)
       or not exists (select 1 from public.users where id = old.user_id) then
      return old;
    end if;
  end if;

  -- Lock this org's admin rows so concurrent demotes/removes can't both read a
  -- stale count; once locked, count the admins other than the one being changed.
  perform 1
  from public.memberships
  where org_id = old.org_id and role = 'admin'
  for update;

  select count(*) into remaining
  from public.memberships
  where org_id = old.org_id and role = 'admin' and user_id <> old.user_id;

  if remaining = 0 then
    raise exception 'organization % must keep at least one admin', old.org_id
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;


ALTER FUNCTION "public"."enforce_min_one_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_eval_run"("run_id" "uuid") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select pgmq.send('eval_runs', jsonb_build_object('runId', run_id::text));
$$;


ALTER FUNCTION "public"."enqueue_eval_run"("run_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_optimization_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  insert into optimization_run_ledger (org_id, entry_type, units, period_start, period_end)
  values (p_org_id, 'grant', p_included, p_period_start, p_period_end)
  on conflict (org_id, period_start) where (entry_type = 'grant') do nothing;
$$;


ALTER FUNCTION "public"."ensure_optimization_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_point_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  insert into point_ledger (org_id, entry_type, points, period_start, period_end)
  values (p_org_id, 'grant', p_included, p_period_start, p_period_end)
  on conflict (org_id, period_start) where (entry_type = 'grant') do nothing;
$$;


ALTER FUNCTION "public"."ensure_point_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expire_runs_before"("p_org_id" "uuid", "p_cutoff" timestamp with time zone) RETURNS TABLE("eval_expired" integer, "opt_expired" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  return query
  with e as (
    update public.eval_runs er
       set deleted_at = now()
     where er.deleted_at is null
       and er.created_at < p_cutoff
       and er.status not in ('queued', 'running')
       and er.rubric_id in (select id from public.rubrics where org_id = p_org_id)
    returning 1
  ),
  o as (
    update public.optimization_runs o
       set deleted_at = now()
     where o.deleted_at is null
       and o.created_at < p_cutoff
       and o.status not in ('queued', 'running')
       and o.org_id = p_org_id
    returning 1
  )
  select (select count(*) from e)::integer,
         (select count(*) from o)::integer;
end;
$$;


ALTER FUNCTION "public"."expire_runs_before"("p_org_id" "uuid", "p_cutoff" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_connection_auth"("p_secret_id" "uuid") RETURNS "text"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'vault', 'pg_temp'
    AS $$
  select decrypted_secret from vault.decrypted_secrets where id = p_secret_id;
$$;


ALTER FUNCTION "public"."get_connection_auth"("p_secret_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_provider_secret"("p_secret_id" "uuid") RETURNS "text"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'vault', 'pg_temp'
    AS $$
  select decrypted_secret from vault.decrypted_secrets where id = p_secret_id;
$$;


ALTER FUNCTION "public"."get_provider_secret"("p_secret_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  insert into public.users (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_rate_limit"("p_hashed_key" "text", "p_window_start" timestamp with time zone, "p_surface" "text", "p_keytype" "text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_count integer;
begin
  insert into public.rate_limit_hits (hashed_key, window_start, surface, keytype, count)
  values (p_hashed_key, p_window_start, p_surface, p_keytype, 1)
  on conflict (hashed_key, window_start)
  do update set count = public.rate_limit_hits.count + 1
  returning public.rate_limit_hits.count into v_count;

  return v_count;
end;
$$;


ALTER FUNCTION "public"."increment_rate_limit"("p_hashed_key" "text", "p_window_start" timestamp with time zone, "p_surface" "text", "p_keytype" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."managed_invoice_candidate_orgs"() RETURNS TABLE("org_id" "uuid")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select distinct org_id
  from managed_invoice_lines
  where accrued_usd > invoiced_usd;
$$;


ALTER FUNCTION "public"."managed_invoice_candidate_orgs"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."managed_spend_total"("p_org_id" "uuid", "p_period_start" timestamp with time zone) RETURNS numeric
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(sum(amount_usd) filter (where entry_type = 'accrue'), 0)
  from managed_spend_ledger
  where org_id = p_org_id and period_start = p_period_start;
$$;


ALTER FUNCTION "public"."managed_spend_total"("p_org_id" "uuid", "p_period_start" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."managed_uninvoiced_total"("p_org_id" "uuid", "p_period_start" timestamp with time zone) RETURNS numeric
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(sum(accrued_usd - invoiced_usd), 0)
  from managed_invoice_lines
  where org_id = p_org_id and period_start = p_period_start;
$$;


ALTER FUNCTION "public"."managed_uninvoiced_total"("p_org_id" "uuid", "p_period_start" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_managed_line_invoiced"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_provider" "text", "p_model" "text", "p_amount" numeric, "p_invoice_id" "text", "p_item_id" "text") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  update managed_invoice_lines
  set invoiced_usd           = invoiced_usd + p_amount,
      stripe_invoice_id      = p_invoice_id,
      stripe_invoice_item_id = p_item_id,
      dirty                  = accrued_usd > invoiced_usd + p_amount,
      updated_at             = now()
  where org_id = p_org_id
    and period_start = p_period_start
    and provider = p_provider
    and model = p_model;
$$;


ALTER FUNCTION "public"."mark_managed_line_invoiced"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_provider" "text", "p_model" "text", "p_amount" numeric, "p_invoice_id" "text", "p_item_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."optimization_run_balance"("p_org_id" "uuid", "p_period_start" timestamp with time zone) RETURNS bigint
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(
    sum(
      case entry_type
        when 'grant'   then units
        when 'upgrade' then units
        when 'release' then units
        when 'reserve' then -units
        else 0
      end
    ),
    0
  )
  from optimization_run_ledger
  where org_id = p_org_id
    and period_start = p_period_start;
$$;


ALTER FUNCTION "public"."optimization_run_balance"("p_org_id" "uuid", "p_period_start" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."point_balance"("p_org_id" "uuid", "p_period_start" timestamp with time zone) RETURNS bigint
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(
    sum(
      case entry_type
        when 'grant'   then points
        when 'upgrade' then points
        when 'release' then points
        when 'reserve' then -points
        else 0
      end
    ),
    0
  )
  from point_ledger
  where org_id = p_org_id
    and period_start = p_period_start;
$$;


ALTER FUNCTION "public"."point_balance"("p_org_id" "uuid", "p_period_start" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."projected_overage_usd"("p_point_balance" bigint, "p_point_unit_usd" numeric) RETURNS numeric
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select greatest(0, -p_point_balance) * p_point_unit_usd;
$$;


ALTER FUNCTION "public"."projected_overage_usd"("p_point_balance" bigint, "p_point_unit_usd" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."provider_keys_delete_secret"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'vault', 'pg_temp'
    AS $$
begin
  if old.secret_id is not null then
    delete from vault.secrets where id = old.secret_id;
  end if;
  return old;
end;
$$;


ALTER FUNCTION "public"."provider_keys_delete_secret"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_expired_runs"("p_grace_days" integer DEFAULT 30) RETURNS TABLE("eval_purged" integer, "opt_purged" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_cutoff timestamptz := now() - make_interval(days => p_grace_days);
begin
  return query
  with e as (
    delete from public.eval_runs er
     where er.deleted_at is not null
       and er.deleted_at < v_cutoff
    returning 1
  ),
  o as (
    delete from public.optimization_runs o
     where o.deleted_at is not null
       and o.deleted_at < v_cutoff
    returning 1
  )
  select (select count(*) from e)::integer,
         (select count(*) from o)::integer;
end;
$$;


ALTER FUNCTION "public"."purge_expired_runs"("p_grace_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reap_stale_eval_runs"("p_threshold_minutes" integer DEFAULT 10) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_run      record;
  v_count    int := 0;
  v_affected int;
begin
  -- Stuck 'running' runs: worker died or stalled mid-evaluation. Workflow-driven runs are
  -- skipped — Temporal owns their retries/resumption, so a long run staying 'running' is expected.
  for v_run in
    select id
    from public.eval_runs
    where status = 'running'
      and workflow_id is null
      and updated_at < now() - (p_threshold_minutes || ' minutes')::interval
  loop
    update public.eval_runs
    set status        = 'failed',
        error_message = 'Worker timed out',
        updated_at    = now()
    where id     = v_run.id
      and status = 'running';

    get diagnostics v_affected = row_count;

    -- Only remove the queue message if we actually claimed this run.
    -- v_affected = 0 means a concurrent worker already finished/failed it.
    if v_affected > 0 then
      delete from pgmq.q_eval_runs
      where (message->>'runId')::uuid = v_run.id;

      v_count := v_count + 1;
    end if;
  end loop;

  -- Stuck 'queued' runs with no message to ever dequeue: the create flow died
  -- between reserving and enqueueing. They will never run; fail them so the
  -- settlement sweep below releases their points. Workflow-driven runs are skipped
  -- (workflow_id stamped) — an interactive run stamps workflow_id before starting the
  -- workflow, so a legitimately-started run sitting 'queued' while the worker is down is
  -- Temporal's to resume, not the reaper's to fail. Only a queued run with no workflow_id
  -- AND no pgmq message is truly orphaned.
  update public.eval_runs er
  set status        = 'failed',
      error_message = 'Never reached the queue',
      updated_at    = now()
  where er.status = 'queued'
    and er.workflow_id is null
    and er.updated_at < now() - (p_threshold_minutes || ' minutes')::interval
    and not exists (
      select 1 from pgmq.q_eval_runs q
      where (q.message->>'runId')::uuid = er.id
    );

  -- Settlement sweep: any terminal run still holding an open reservation
  -- settles by its status. Idempotent (settle_eval_run_points early-returns on
  -- an existing settle entry), so re-running the reaper is always safe.
  perform public.settle_eval_run_points(r.eval_run_id, er.status::text)
  from public.point_ledger r
  join public.eval_runs er on er.id = r.eval_run_id
  where r.entry_type = 'reserve'
    and er.status in ('completed', 'failed', 'skipped')
    and not exists (
      select 1 from public.point_ledger s
      where s.eval_run_id = r.eval_run_id and s.entry_type = 'settle'
    );

  -- Managed-reservation sweep: the managed mirror of the Points sweep above. A worker that
  -- dies between a run's terminal-status flip and its settlement leaves the managed reserve
  -- outstanding with nothing else to release it (the terminal Activity's retry is guarded by
  -- the flip), pinning committed managed-spend cap headroom for the rest of the period.
  -- release_managed_reservation is idempotent — it releases only the outstanding
  -- (reserve − release) balance — so re-running is always safe.
  perform public.release_managed_reservation(m.eval_run_id, null)
  from (
    select l.eval_run_id
    from public.managed_spend_ledger l
    join public.eval_runs er on er.id = l.eval_run_id
    where l.eval_run_id is not null
      and er.status in ('completed', 'failed', 'skipped')
    group by l.eval_run_id
    having sum(
      case l.entry_type when 'reserve' then l.amount_usd when 'release' then -l.amount_usd else 0 end
    ) > 0
  ) m;

  return v_count;
end;
$$;


ALTER FUNCTION "public"."reap_stale_eval_runs"("p_threshold_minutes" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reap_stale_optimization_runs"("p_threshold_minutes" integer DEFAULT 30) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_count int;
begin
  with reaped as (
    update public.optimization_runs
    set status        = 'failed',
        error_message = 'Run timed out — no progress within the staleness window',
        updated_at    = now()
    where status = 'running'
      and updated_at < now() - (p_threshold_minutes || ' minutes')::interval
    returning 1
  )
  select count(*) into v_count from reaped;

  with reaped_queued as (
    update public.optimization_runs
    set status        = 'failed',
        error_message = 'Never started',
        updated_at    = now()
    where status = 'queued'
      and workflow_id is null
      and updated_at < now() - (p_threshold_minutes || ' minutes')::interval
    returning 1
  )
  select v_count + count(*) into v_count from reaped_queued;

  -- Run-unit settlement sweep (idempotent).
  perform public.settle_optimization_run(r.opt_run_id)
  from public.optimization_run_ledger r
  join public.optimization_runs o on o.id = r.opt_run_id
  where r.entry_type = 'reserve'
    and o.status in ('completed', 'failed')
    and not exists (
      select 1 from public.optimization_run_ledger s
      where s.opt_run_id = r.opt_run_id and s.entry_type = 'settle'
    );

  -- Point settlement sweep for overage runs (idempotent). The run's terminal
  -- status is the outcome; completed/failed both settle to scored rollouts.
  perform public.settle_optimization_run_points(r.opt_run_id, o.status::text)
  from public.point_ledger r
  join public.optimization_runs o on o.id = r.opt_run_id
  where r.entry_type = 'reserve'
    and r.opt_run_id is not null
    and o.status in ('completed', 'failed')
    and not exists (
      select 1 from public.point_ledger s
      where s.opt_run_id = r.opt_run_id and s.entry_type = 'settle'
    );

  return v_count;
end;
$$;


ALTER FUNCTION "public"."reap_stale_optimization_runs"("p_threshold_minutes" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reconcile_plan_grants"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included_points" bigint, "p_included_runs" bigint) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_granted bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 1));

  perform ensure_point_grant(p_org_id, p_period_start, p_period_end, p_included_points);
  select coalesce(sum(points), 0) into v_granted
  from point_ledger
  where org_id = p_org_id
    and period_start = p_period_start
    and entry_type in ('grant', 'upgrade');
  if p_included_points > v_granted then
    insert into point_ledger (org_id, entry_type, points, period_start, period_end, meta)
    values (p_org_id, 'upgrade', p_included_points - v_granted, p_period_start, p_period_end,
            jsonb_build_object('included', p_included_points));
  end if;

  perform ensure_optimization_grant(p_org_id, p_period_start, p_period_end, p_included_runs);
  select coalesce(sum(units), 0) into v_granted
  from optimization_run_ledger
  where org_id = p_org_id
    and period_start = p_period_start
    and entry_type in ('grant', 'upgrade');
  if p_included_runs > v_granted then
    insert into optimization_run_ledger (org_id, entry_type, units, period_start, period_end, meta)
    values (p_org_id, 'upgrade', p_included_runs - v_granted, p_period_start, p_period_end,
            jsonb_build_object('included', p_included_runs));
  end if;

  perform refresh_overage_line(p_org_id, p_period_start, 'points');
  perform refresh_overage_line(p_org_id, p_period_start, 'runs');
end;
$$;


ALTER FUNCTION "public"."reconcile_plan_grants"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included_points" bigint, "p_included_runs" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_managed_invoice_lines"("p_org_id" "uuid", "p_period_start" timestamp with time zone) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  insert into managed_invoice_lines
    (org_id, period_start, period_end, provider, model, accrued_usd, unit_markup_pct, dirty)
  select
    org_id, period_start, max(period_end), provider, model,
    sum(amount_usd), max(markup_pct), true
  from managed_spend_ledger
  where org_id = p_org_id
    and period_start = p_period_start
    and entry_type = 'accrue'
    and provider is not null
    and model is not null
  group by org_id, period_start, provider, model
  on conflict (org_id, period_start, provider, model) do update
    set accrued_usd     = excluded.accrued_usd,
        unit_markup_pct = excluded.unit_markup_pct,
        dirty           = managed_invoice_lines.dirty
                          or managed_invoice_lines.accrued_usd is distinct from excluded.accrued_usd,
        updated_at      = now();
end;
$$;


ALTER FUNCTION "public"."refresh_managed_invoice_lines"("p_org_id" "uuid", "p_period_start" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_overage_line"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_meter" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_over bigint;
begin
  -- Fast path for the default world: an org that never opted into overage
  -- (no billing_settings row, even a cleared one keeps its row) and has no
  -- line yet cannot have settled overage — reserves hard-stop at the balance.
  -- Skips the period aggregate on every settle for capless orgs.
  if not exists (
       select 1 from overage_invoice_lines
       where org_id = p_org_id and period_start = p_period_start and meter = p_meter
     )
     and not exists (select 1 from billing_settings where org_id = p_org_id)
  then
    return;
  end if;

  if p_meter = 'points' then
    perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));
    select greatest(
      0,
      coalesce(sum(points) filter (where entry_type = 'settle'), 0)
      - coalesce(sum(points) filter (where entry_type in ('grant', 'upgrade')), 0)
    ) into v_over
    from point_ledger
    where org_id = p_org_id and period_start = p_period_start;
  elsif p_meter = 'runs' then
    perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 1));
    select greatest(
      0,
      coalesce(sum(units) filter (where entry_type = 'settle'), 0)
      - coalesce(sum(units) filter (where entry_type in ('grant', 'upgrade')), 0)
    ) into v_over
    from optimization_run_ledger
    where org_id = p_org_id and period_start = p_period_start;
  else
    raise exception 'refresh_overage_line: unknown meter %', p_meter;
  end if;

  if v_over > 0 then
    insert into overage_invoice_lines (org_id, period_start, meter, quantity)
    values (p_org_id, p_period_start, p_meter, v_over)
    on conflict (org_id, period_start, meter) do update
      set quantity   = excluded.quantity,
          dirty      = overage_invoice_lines.dirty
                       or overage_invoice_lines.quantity is distinct from excluded.quantity,
          updated_at = now();
  else
    update overage_invoice_lines
    set quantity = 0, dirty = true, updated_at = now()
    where org_id = p_org_id
      and period_start = p_period_start
      and meter = p_meter
      and quantity <> 0;
  end if;
end;
$$;


ALTER FUNCTION "public"."refresh_overage_line"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_meter" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_access_code_claim"("p_access_code_id" "uuid") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  update access_codes
  set redeemed_count = greatest(redeemed_count - 1, 0)
  where id = p_access_code_id;
$$;


ALTER FUNCTION "public"."release_access_code_claim"("p_access_code_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_managed_reservation"("p_eval_run_id" "uuid" DEFAULT NULL::"uuid", "p_opt_run_id" "uuid" DEFAULT NULL::"uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  r record;
  v_outstanding numeric;
begin
  if num_nonnulls(p_eval_run_id, p_opt_run_id) <> 1 then
    raise exception 'release_managed_reservation: exactly one run id required';
  end if;

  select org_id, period_start, period_end into r
  from managed_spend_ledger
  where entry_type = 'reserve'
    and ((p_eval_run_id is not null and eval_run_id = p_eval_run_id)
      or (p_opt_run_id is not null and opt_run_id = p_opt_run_id))
  limit 1;
  if not found then
    return; -- BYO or unpriced run: never reserved, nothing to release.
  end if;

  perform pg_advisory_xact_lock(hashtextextended(r.org_id::text, 2));

  select coalesce(sum(
    case entry_type when 'reserve' then amount_usd when 'release' then -amount_usd else 0 end
  ), 0)
  into v_outstanding
  from managed_spend_ledger
  where ((p_eval_run_id is not null and eval_run_id = p_eval_run_id)
      or (p_opt_run_id is not null and opt_run_id = p_opt_run_id));

  if v_outstanding > 0 then
    insert into managed_spend_ledger
      (org_id, entry_type, amount_usd, eval_run_id, opt_run_id, period_start, period_end)
    values
      (r.org_id, 'release', v_outstanding, p_eval_run_id, p_opt_run_id, r.period_start, r.period_end);
  end if;
end;
$$;


ALTER FUNCTION "public"."release_managed_reservation"("p_eval_run_id" "uuid", "p_opt_run_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_eval_points"("p_org_id" "uuid", "p_run_id" "uuid", "p_cost" bigint, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint, "p_meta" "jsonb" DEFAULT '{}'::"jsonb", "p_point_unit_usd" numeric DEFAULT NULL::numeric) RETURNS TABLE("reserved" boolean, "balance" bigint, "cap_usd" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_balance bigint;
  v_cap numeric;
begin
  if p_cost < 0 then
    raise exception 'reserve_eval_points: negative cost %', p_cost;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));
  perform ensure_point_grant(p_org_id, p_period_start, p_period_end, p_included);

  -- A plan with overage passes its point rate; null = hard-stop (Free, or a
  -- payment-failing Team whose rate the app suppresses).
  if p_point_unit_usd is not null then
    select overage_cap_usd into v_cap from billing_settings where org_id = p_org_id;
  end if;

  v_balance := point_balance(p_org_id, p_period_start);
  if p_cost > v_balance then
    if v_cap is null then
      return query select false, v_balance, v_cap;
      return;
    end if;
    if projected_overage_usd(v_balance - p_cost, p_point_unit_usd) > v_cap then
      return query select false, v_balance, v_cap;
      return;
    end if;
  end if;

  insert into point_ledger (org_id, entry_type, points, eval_run_id, period_start, period_end, meta)
  values (p_org_id, 'reserve', p_cost, p_run_id, p_period_start, p_period_end, p_meta);

  return query select true, v_balance - p_cost, v_cap;
end;
$$;


ALTER FUNCTION "public"."reserve_eval_points"("p_org_id" "uuid", "p_run_id" "uuid", "p_cost" bigint, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint, "p_meta" "jsonb", "p_point_unit_usd" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_managed_spend"("p_org_id" "uuid", "p_estimate_usd" numeric, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_cap_usd" numeric, "p_markup_pct" numeric, "p_eval_run_id" "uuid" DEFAULT NULL::"uuid", "p_opt_run_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("reserved" boolean, "committed_usd" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_committed numeric;
begin
  if p_estimate_usd < 0 then
    raise exception 'reserve_managed_spend: negative estimate %', p_estimate_usd;
  end if;
  if num_nonnulls(p_eval_run_id, p_opt_run_id) <> 1 then
    raise exception 'reserve_managed_spend: exactly one run id required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 2));

  select coalesce(sum(
    case entry_type
      when 'reserve' then amount_usd
      when 'accrue'  then amount_usd
      when 'release' then -amount_usd
    end
  ), 0)
  into v_committed
  from managed_spend_ledger
  where org_id = p_org_id and period_start = p_period_start;

  -- No cap should never happen for a managed run (paid plans always default a
  -- cap), but fail closed if one is somehow absent.
  if p_cap_usd is null or v_committed + p_estimate_usd > p_cap_usd then
    return query select false, v_committed;
    return;
  end if;

  -- Snapshot markup_pct + cap_usd on the reserve row: the worker reads them back
  -- for cost computation and the mid-run cap check, model-independent and frozen
  -- for this run even if the Team changes the cap mid-flight.
  insert into managed_spend_ledger
    (org_id, entry_type, amount_usd, eval_run_id, opt_run_id, markup_pct, cap_usd, period_start, period_end)
  values
    (p_org_id, 'reserve', p_estimate_usd, p_eval_run_id, p_opt_run_id, p_markup_pct, p_cap_usd, p_period_start, p_period_end);

  return query select true, v_committed + p_estimate_usd;
end;
$$;


ALTER FUNCTION "public"."reserve_managed_spend"("p_org_id" "uuid", "p_estimate_usd" numeric, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_cap_usd" numeric, "p_markup_pct" numeric, "p_eval_run_id" "uuid", "p_opt_run_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_optimization_points"("p_org_id" "uuid", "p_run_id" "uuid", "p_cost" bigint, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint, "p_meta" "jsonb" DEFAULT '{}'::"jsonb", "p_point_unit_usd" numeric DEFAULT NULL::numeric) RETURNS TABLE("reserved" boolean, "balance" bigint, "cap_usd" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_balance bigint;
  v_cap numeric;
begin
  if p_cost < 0 then
    raise exception 'reserve_optimization_points: negative cost %', p_cost;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));
  perform ensure_point_grant(p_org_id, p_period_start, p_period_end, p_included);

  if p_point_unit_usd is not null then
    select overage_cap_usd into v_cap from billing_settings where org_id = p_org_id;
  end if;

  v_balance := point_balance(p_org_id, p_period_start);
  if p_cost > v_balance then
    if v_cap is null then
      return query select false, v_balance, v_cap;
      return;
    end if;
    if projected_overage_usd(v_balance - p_cost, p_point_unit_usd) > v_cap then
      return query select false, v_balance, v_cap;
      return;
    end if;
  end if;

  insert into point_ledger (org_id, entry_type, points, opt_run_id, period_start, period_end, meta)
  values (p_org_id, 'reserve', p_cost, p_run_id, p_period_start, p_period_end, p_meta);

  return query select true, v_balance - p_cost, v_cap;
end;
$$;


ALTER FUNCTION "public"."reserve_optimization_points"("p_org_id" "uuid", "p_run_id" "uuid", "p_cost" bigint, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint, "p_meta" "jsonb", "p_point_unit_usd" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reserve_optimization_run"("p_org_id" "uuid", "p_run_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) RETURNS TABLE("reserved" boolean, "balance" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_balance bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 1));
  perform ensure_optimization_grant(p_org_id, p_period_start, p_period_end, p_included);

  v_balance := optimization_run_balance(p_org_id, p_period_start);
  if v_balance < 1 then
    return query select false, v_balance;
    return;
  end if;

  insert into optimization_run_ledger (org_id, entry_type, units, opt_run_id, period_start, period_end)
  values (p_org_id, 'reserve', 1, p_run_id, p_period_start, p_period_end);

  return query select true, v_balance - 1;
end;
$$;


ALTER FUNCTION "public"."reserve_optimization_run"("p_org_id" "uuid", "p_run_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."restore_runs_since"("p_org_id" "uuid", "p_cutoff" timestamp with time zone) RETURNS TABLE("eval_restored" integer, "opt_restored" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  return query
  with e as (
    update public.eval_runs er
       set deleted_at = null
     where er.deleted_at is not null
       and er.created_at >= p_cutoff
       and er.rubric_id in (select id from public.rubrics where org_id = p_org_id)
    returning 1
  ),
  o as (
    update public.optimization_runs o
       set deleted_at = null
     where o.deleted_at is not null
       and o.created_at >= p_cutoff
       and o.org_id = p_org_id
    returning 1
  )
  select (select count(*) from e)::integer,
         (select count(*) from o)::integer;
end;
$$;


ALTER FUNCTION "public"."restore_runs_since"("p_org_id" "uuid", "p_cutoff" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."retention_candidate_orgs"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select rb.org_id
    from public.eval_runs er
    join public.rubrics rb on rb.id = er.rubric_id
   where er.deleted_at is null
  union
  select o.org_id
    from public.optimization_runs o
   where o.deleted_at is null;
$$;


ALTER FUNCTION "public"."retention_candidate_orgs"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_provider_key"("p_org_id" "uuid", "p_provider" "text", "p_secret" "text", "p_last4" "text", "p_created_by" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'vault', 'pg_temp'
    AS $$
declare
  v_old_secret uuid;
  v_new_secret uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || p_provider, 0));

  select secret_id into v_old_secret
  from public.provider_keys
  where org_id = p_org_id and provider = p_provider;

  v_new_secret := vault.create_secret(
    p_secret,
    'pk:' || p_org_id || ':' || p_provider || ':' || extract(epoch from clock_timestamp())
  );

  insert into public.provider_keys (org_id, provider, secret_id, last4, created_by, updated_at)
  values (p_org_id, p_provider, v_new_secret, p_last4, p_created_by, now())
  on conflict (org_id, provider) do update
    set secret_id  = excluded.secret_id,
        last4      = excluded.last4,
        created_by = excluded.created_by,
        updated_at = excluded.updated_at;

  -- Purge the secret the row no longer references (the delete trigger only fires
  -- on row DELETE, not this UPDATE).
  if v_old_secret is not null and v_old_secret <> v_new_secret then
    delete from vault.secrets where id = v_old_secret;
  end if;

  return v_new_secret;
end;
$$;


ALTER FUNCTION "public"."set_provider_key"("p_org_id" "uuid", "p_provider" "text", "p_secret" "text", "p_last4" "text", "p_created_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_eval_run_points"("p_run_id" "uuid", "p_outcome" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  r record;
  v_scored bigint;
  v_actual bigint;
begin
  if p_outcome not in ('completed', 'failed', 'skipped') then
    raise exception 'settle_eval_run_points: unknown outcome %', p_outcome;
  end if;

  select * into r
  from point_ledger
  where eval_run_id = p_run_id and entry_type = 'reserve';
  if not found then
    return;
  end if;

  -- Serialize concurrent settles of the same org (worker terminal path vs
  -- reaper sweep) so the settled-once guard below is authoritative — the S4
  -- race fix (20260612000002), preserved.
  perform pg_advisory_xact_lock(hashtextextended(r.org_id::text, 0));

  -- A reservation settles exactly once. Without this guard, a replay with a
  -- DIFFERENT outcome would no-op the settle insert but still compute a fresh
  -- release — minting back points the first settlement recorded as consumed.
  if exists (
    select 1 from point_ledger
    where eval_run_id = p_run_id and entry_type = 'settle'
  ) then
    return;
  end if;

  if p_outcome = 'completed' then
    v_actual := r.points;
  elsif p_outcome = 'skipped' then
    v_actual := 0;
  else
    -- Failed: charge what was demonstrably scored. The worker currently writes
    -- results only after a fully-successful evaluation, so today this settles 0
    -- and releases everything — deliberately generous (never overcharge a
    -- failure). If per-row result writes land later, actuals activate here
    -- automatically. A reservation missing per_row_cost also settles free, by
    -- the same never-overcharge rule.
    select count(distinct row_index) into v_scored
    from eval_run_results
    where eval_run_id = p_run_id;
    v_actual := least(
      v_scored * coalesce((r.meta ->> 'per_row_cost')::bigint, 0),
      r.points
    );
  end if;

  insert into point_ledger (org_id, entry_type, points, eval_run_id, period_start, period_end, meta)
  values (r.org_id, 'settle', v_actual, p_run_id, r.period_start, r.period_end,
          jsonb_build_object('outcome', p_outcome))
  on conflict (eval_run_id) where (entry_type = 'settle') do nothing;

  if r.points - v_actual > 0 then
    insert into point_ledger (org_id, entry_type, points, eval_run_id, period_start, period_end)
    values (r.org_id, 'release', r.points - v_actual, p_run_id, r.period_start, r.period_end)
    on conflict (eval_run_id) where (entry_type = 'release') do nothing;
  end if;

  -- Overage projection (#183): settled usage beyond grants becomes (or
  -- updates) the period's invoice line.
  perform refresh_overage_line(r.org_id, r.period_start, 'points');
end;
$$;


ALTER FUNCTION "public"."settle_eval_run_points"("p_run_id" "uuid", "p_outcome" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_optimization_run"("p_run_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  r record;
  v_worked boolean;
begin
  select * into r
  from optimization_run_ledger
  where opt_run_id = p_run_id and entry_type = 'reserve';
  if not found then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(r.org_id::text, 1));

  if exists (
    select 1 from optimization_run_ledger
    where opt_run_id = p_run_id and entry_type = 'settle'
  ) then
    return;
  end if;

  select exists (
    select 1
    from optimization_rollouts ro
    join optimization_candidates c on c.id = ro.candidate_id
    where c.opt_run_id = p_run_id
  ) into v_worked;

  insert into optimization_run_ledger (org_id, entry_type, units, opt_run_id, period_start, period_end, meta)
  values (r.org_id, 'settle', case when v_worked then 1 else 0 end, p_run_id,
          r.period_start, r.period_end, jsonb_build_object('worked', v_worked))
  on conflict (opt_run_id) where (entry_type = 'settle') do nothing;

  if not v_worked then
    insert into optimization_run_ledger (org_id, entry_type, units, opt_run_id, period_start, period_end)
    values (r.org_id, 'release', 1, p_run_id, r.period_start, r.period_end)
    on conflict (opt_run_id) where (entry_type = 'release') do nothing;
  end if;

  -- Overage projection (#183).
  perform refresh_overage_line(r.org_id, r.period_start, 'runs');
end;
$$;


ALTER FUNCTION "public"."settle_optimization_run"("p_run_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_optimization_run_points"("p_run_id" "uuid", "p_outcome" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  r record;
  v_scored bigint;
  v_actual bigint;
begin
  if p_outcome not in ('completed', 'failed', 'skipped') then
    raise exception 'settle_optimization_run_points: unknown outcome %', p_outcome;
  end if;

  select * into r
  from point_ledger
  where opt_run_id = p_run_id and entry_type = 'reserve';
  if not found then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(r.org_id::text, 0));

  if exists (
    select 1 from point_ledger
    where opt_run_id = p_run_id and entry_type = 'settle'
  ) then
    return;
  end if;

  if p_outcome = 'skipped' then
    v_actual := 0;
  else
    select count(distinct ro.id) into v_scored
    from rollout_results rr
    join optimization_rollouts ro on ro.id = rr.rollout_id
    join optimization_candidates c on c.id = ro.candidate_id
    where c.opt_run_id = p_run_id;
    v_actual := least(
      v_scored * coalesce((r.meta ->> 'per_rollout_cost')::bigint, 0),
      r.points
    );
  end if;

  insert into point_ledger (org_id, entry_type, points, opt_run_id, period_start, period_end, meta)
  values (r.org_id, 'settle', v_actual, p_run_id, r.period_start, r.period_end,
          jsonb_build_object('outcome', p_outcome))
  on conflict (opt_run_id) where (entry_type = 'settle' and opt_run_id is not null) do nothing;

  if r.points - v_actual > 0 then
    insert into point_ledger (org_id, entry_type, points, opt_run_id, period_start, period_end)
    values (r.org_id, 'release', r.points - v_actual, p_run_id, r.period_start, r.period_end)
    on conflict (opt_run_id) where (entry_type = 'release' and opt_run_id is not null) do nothing;
  end if;

  perform refresh_overage_line(r.org_id, r.period_start, 'points');
end;
$$;


ALTER FUNCTION "public"."settle_optimization_run_points"("p_run_id" "uuid", "p_outcome" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tick_managed_threshold"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp', 'net'
    AS $$
declare
  v_count integer;
  v_cfg   record;
begin
  select count(distinct org_id) into v_count
  from managed_invoice_lines
  where accrued_usd > invoiced_usd;

  if v_count > 0 then
    select managed_threshold_url, managed_threshold_secret into v_cfg
    from worker_config where id = 1;
    if v_cfg.managed_threshold_url is not null and v_cfg.managed_threshold_url <> '' then
      perform net.http_post(
        url     => v_cfg.managed_threshold_url,
        body    => '{}'::jsonb,
        headers => case
          when coalesce(v_cfg.managed_threshold_secret, '') <> '' then
            jsonb_build_object('Content-Type', 'application/json',
                               'Authorization', 'Bearer ' || v_cfg.managed_threshold_secret)
          else '{"Content-Type":"application/json"}'::jsonb
        end
      );
    end if;
  end if;

  return v_count;
end;
$$;


ALTER FUNCTION "public"."tick_managed_threshold"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tick_retention"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp', 'net'
    AS $$
declare
  v_count integer;
  v_cfg   record;
begin
  select count(*) into v_count from public.retention_candidate_orgs();

  if v_count > 0 then
    select retention_url, retention_secret into v_cfg
    from public.worker_config where id = 1;
    if v_cfg.retention_url is not null and v_cfg.retention_url <> '' then
      perform net.http_post(
        url     => v_cfg.retention_url,
        body    => '{}'::jsonb,
        headers => case
          when coalesce(v_cfg.retention_secret, '') <> '' then
            jsonb_build_object('Content-Type', 'application/json',
                               'Authorization', 'Bearer ' || v_cfg.retention_secret)
          else '{"Content-Type":"application/json"}'::jsonb
        end
      );
    end if;
  end if;

  return v_count;
end;
$$;


ALTER FUNCTION "public"."tick_retention"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tick_schedules"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_sched  record;
  v_cfg    record;
  v_run_id uuid;
  v_count  int := 0;
begin
  for v_sched in
    select *
    from public.schedules
    where enabled and next_run_at is not null and next_run_at <= now()
    order by next_run_at
    for update skip locked
    limit 100
  loop
    insert into public.eval_runs
      (created_by, rubric_id, schedule_id, eval_type, description, notification_emails)
    values
      (v_sched.created_by, v_sched.rubric_id, v_sched.id, v_sched.eval_type,
       v_sched.description, coalesce(v_sched.notification_emails, '{}'::text[]))
    returning id into v_run_id;

    -- Copy the fixed input set; agent_output is left empty for the worker to fill.
    insert into public.eval_run_rows
      (eval_run_id, row_index, user_input, agent_output, expected_output, retrieval_context)
    select v_run_id, row_index, user_input, '', expected_output, retrieval_context
    from public.schedule_inputs
    where schedule_id = v_sched.id;

    perform public.enqueue_eval_run(v_run_id);

    update public.schedules
    set last_run_at = now(),
        next_run_at = public.compute_next_run_at(
          frequency, local_hour, days_of_week, day_of_month, timezone, now()),
        updated_at  = now()
    where id = v_sched.id;

    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    select wake_url, wake_secret into v_cfg from public.worker_config where id = 1;
    if v_cfg.wake_url is not null and v_cfg.wake_url <> '' then
      perform net.http_post(
        url     => v_cfg.wake_url,
        body    => '{}'::jsonb,
        headers => case
          when coalesce(v_cfg.wake_secret, '') <> '' then
            jsonb_build_object('Content-Type', 'application/json',
                               'Authorization', 'Bearer ' || v_cfg.wake_secret)
          else '{"Content-Type":"application/json"}'::jsonb
        end
      );
    end if;
  end if;

  return v_count;
end;
$$;


ALTER FUNCTION "public"."tick_schedules"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."access_code_redemptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "access_code_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "org_id" "uuid",
    "benefit_consumed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."access_code_redemptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."access_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "max_redemptions" integer NOT NULL,
    "redeemed_count" integer DEFAULT 0 NOT NULL,
    "expires_at" timestamp with time zone,
    "trial_days" integer,
    "stripe_coupon_id" "text",
    "plan_slug" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "access_codes_max_redemptions_check" CHECK (("max_redemptions" > 0)),
    CONSTRAINT "access_codes_redeemed_count_check" CHECK (("redeemed_count" >= 0)),
    CONSTRAINT "access_codes_trial_days_check" CHECK ((("trial_days" IS NULL) OR ("trial_days" > 0)))
);


ALTER TABLE "public"."access_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billing_events" (
    "stripe_event_id" "text" NOT NULL,
    "type" "text" NOT NULL,
    "processed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."billing_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billing_notifications" (
    "org_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "period_start" timestamp with time zone NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."billing_notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billing_settings" (
    "org_id" "uuid" NOT NULL,
    "overage_cap_usd" numeric(10,2),
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "uuid",
    "managed_spend_cap_usd" numeric(10,2),
    CONSTRAINT "billing_settings_managed_spend_cap_usd_check" CHECK (("managed_spend_cap_usd" > (0)::numeric)),
    CONSTRAINT "billing_settings_overage_cap_usd_check" CHECK (("overage_cap_usd" > (0)::numeric))
);


ALTER TABLE "public"."billing_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "kind" "text" DEFAULT 'agent'::"text" NOT NULL,
    "provider" "text" DEFAULT 'custom'::"text" NOT NULL,
    "endpoint" "text",
    "auth_header" "text",
    "auth_secret_id" "uuid",
    "request_template" "jsonb",
    "response_path" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "config" "jsonb",
    "optimizable_prompts" "jsonb",
    "agent_kind" "text" DEFAULT 'external'::"text" NOT NULL,
    "target_model" "text",
    CONSTRAINT "connections_agent_kind_check" CHECK (("agent_kind" = ANY (ARRAY['external'::"text", 'managed'::"text"]))),
    CONSTRAINT "connections_agent_kind_shape" CHECK ((("kind" <> 'agent'::"text") OR (("agent_kind" = 'external'::"text") AND ("endpoint" IS NOT NULL) AND ("response_path" IS NOT NULL) AND ("target_model" IS NULL)) OR (("agent_kind" = 'managed'::"text") AND ("target_model" IS NOT NULL) AND ("endpoint" IS NULL) AND ("response_path" IS NULL) AND ("request_template" IS NULL)))),
    CONSTRAINT "connections_kind_check" CHECK (("kind" = ANY (ARRAY['agent'::"text", 'dataset'::"text"])))
);


ALTER TABLE "public"."connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customers" (
    "org_id" "uuid" NOT NULL,
    "stripe_customer_id" "text" NOT NULL,
    "stripe_subscription_id" "text",
    "status" "text",
    "stripe_price_id" "text",
    "current_period_start" timestamp with time zone,
    "current_period_end" timestamp with time zone,
    "mirror_event_at" timestamp with time zone,
    "email" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cancel_at_period_end" boolean DEFAULT false NOT NULL,
    "pending_price_id" "text",
    "pending_change_at" timestamp with time zone,
    "stripe_schedule_id" "text",
    "schedule_event_at" timestamp with time zone,
    "managed_payment_failed_at" timestamp with time zone,
    "managed_failed_invoice_id" "text"
);


ALTER TABLE "public"."customers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."eval_run_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "eval_run_id" "uuid" NOT NULL,
    "row_index" integer NOT NULL,
    "criterion_name" "text" NOT NULL,
    "score" numeric(4,3) NOT NULL,
    "reasoning" "text" NOT NULL
);


ALTER TABLE "public"."eval_run_results" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."eval_run_rows" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "eval_run_id" "uuid" NOT NULL,
    "row_index" integer NOT NULL,
    "user_input" "text" NOT NULL,
    "agent_output" "text" NOT NULL,
    "expected_output" "text",
    "retrieval_context" "text"
);


ALTER TABLE "public"."eval_run_rows" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."eval_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_by" "uuid" NOT NULL,
    "rubric_id" "uuid" NOT NULL,
    "status" "public"."eval_run_status" DEFAULT 'queued'::"public"."eval_run_status" NOT NULL,
    "eval_type" "text" DEFAULT 'tabular'::"text" NOT NULL,
    "description" "text",
    "notification_emails" "text"[],
    "overall_score" numeric(4,3),
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "schedule_id" "uuid",
    "deleted_at" timestamp with time zone,
    "workflow_id" "text"
);


ALTER TABLE "public"."eval_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invitations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "token_hash" "text" NOT NULL,
    "invited_by" "uuid",
    "expires_at" timestamp with time zone NOT NULL,
    "accepted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "invitations_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'member'::"text"])))
);


ALTER TABLE "public"."invitations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."managed_invoice_lines" (
    "org_id" "uuid" NOT NULL,
    "period_start" timestamp with time zone NOT NULL,
    "period_end" timestamp with time zone NOT NULL,
    "provider" "text" NOT NULL,
    "model" "text" NOT NULL,
    "accrued_usd" numeric(14,6) DEFAULT 0 NOT NULL,
    "invoiced_usd" numeric(14,6) DEFAULT 0 NOT NULL,
    "unit_markup_pct" numeric(6,3),
    "stripe_invoice_item_id" "text",
    "stripe_invoice_id" "text",
    "dirty" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "managed_invoice_lines_accrued_usd_check" CHECK (("accrued_usd" >= (0)::numeric)),
    CONSTRAINT "managed_invoice_lines_invoiced_usd_check" CHECK (("invoiced_usd" >= (0)::numeric))
);


ALTER TABLE "public"."managed_invoice_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."managed_spend_ledger" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "entry_type" "text" NOT NULL,
    "amount_usd" numeric(14,6) NOT NULL,
    "eval_run_id" "uuid",
    "opt_run_id" "uuid",
    "provider" "text",
    "model" "text",
    "input_tokens" bigint,
    "output_tokens" bigint,
    "input_unit_usd" numeric(20,12),
    "output_unit_usd" numeric(20,12),
    "markup_pct" numeric(6,3),
    "cap_usd" numeric(10,2),
    "call_kind" "text",
    "period_start" timestamp with time zone NOT NULL,
    "period_end" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "managed_spend_ledger_amount_usd_check" CHECK (("amount_usd" >= (0)::numeric)),
    CONSTRAINT "managed_spend_ledger_call_kind_check" CHECK ((("call_kind" IS NULL) OR ("call_kind" = ANY (ARRAY['judge'::"text", 'reflect'::"text", 'agent'::"text"])))),
    CONSTRAINT "managed_spend_ledger_entry_type_check" CHECK (("entry_type" = ANY (ARRAY['reserve'::"text", 'accrue'::"text", 'release'::"text"]))),
    CONSTRAINT "managed_spend_ledger_input_tokens_check" CHECK ((("input_tokens" IS NULL) OR ("input_tokens" >= 0))),
    CONSTRAINT "managed_spend_ledger_one_run" CHECK (("num_nonnulls"("eval_run_id", "opt_run_id") <= 1)),
    CONSTRAINT "managed_spend_ledger_output_tokens_check" CHECK ((("output_tokens" IS NULL) OR ("output_tokens" >= 0)))
);


ALTER TABLE "public"."managed_spend_ledger" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."memberships" (
    "org_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "memberships_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'member'::"text"])))
);


ALTER TABLE "public"."memberships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."optimization_candidates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "opt_run_id" "uuid" NOT NULL,
    "parent_id" "uuid",
    "generation" integer DEFAULT 0 NOT NULL,
    "prompts" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "iteration" integer,
    "target_module" "text",
    "merged_from_id" "uuid"
);


ALTER TABLE "public"."optimization_candidates" OWNER TO "postgres";


COMMENT ON COLUMN "public"."optimization_candidates"."merged_from_id" IS 'Secondary parent for a system-aware merge Candidate (#84); null for the seed and mutation children. parent_id remains the primary lineage.';



CREATE TABLE IF NOT EXISTS "public"."optimization_inputs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "opt_run_id" "uuid" NOT NULL,
    "instance_index" integer NOT NULL,
    "user_input" "text" NOT NULL,
    "expected_output" "text",
    "retrieval_context" "text"
);


ALTER TABLE "public"."optimization_inputs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."optimization_rollouts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "candidate_id" "uuid" NOT NULL,
    "instance_index" integer NOT NULL,
    "phase" "text" NOT NULL,
    "agent_output" "text",
    "trace" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "optimization_rollouts_phase_check" CHECK (("phase" = ANY (ARRAY['minibatch'::"text", 'pareto'::"text", 'full'::"text"])))
);


ALTER TABLE "public"."optimization_rollouts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."optimization_run_ledger" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "entry_type" "text" NOT NULL,
    "units" bigint NOT NULL,
    "opt_run_id" "uuid",
    "period_start" timestamp with time zone NOT NULL,
    "period_end" timestamp with time zone NOT NULL,
    "meta" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "optimization_run_ledger_entry_type_check" CHECK (("entry_type" = ANY (ARRAY['grant'::"text", 'reserve'::"text", 'settle'::"text", 'release'::"text", 'upgrade'::"text"]))),
    CONSTRAINT "optimization_run_ledger_units_check" CHECK (("units" >= 0))
);


ALTER TABLE "public"."optimization_run_ledger" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."optimization_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "connection_id" "uuid" NOT NULL,
    "rubric_id" "uuid" NOT NULL,
    "eval_type" "text" DEFAULT 'tabular'::"text" NOT NULL,
    "budget_rollouts" integer NOT NULL,
    "max_iters" integer NOT NULL,
    "plateau_patience" integer,
    "reflect_model" "text" DEFAULT 'claude-sonnet-4-6'::"text" NOT NULL,
    "status" "public"."optimization_run_status" DEFAULT 'queued'::"public"."optimization_run_status" NOT NULL,
    "best_candidate_id" "uuid",
    "best_score" numeric(4,3),
    "workflow_id" "text",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "paused_reason" "text",
    "pause_max_wait_minutes" integer DEFAULT 1440 NOT NULL,
    "probe_interval_seconds" integer DEFAULT 60 NOT NULL,
    "deleted_at" timestamp with time zone,
    "mode" "text" DEFAULT 'reflective'::"text" NOT NULL,
    "seed_score" numeric(4,3),
    CONSTRAINT "optimization_runs_mode_check" CHECK (("mode" = ANY (ARRAY['simple'::"text", 'reflective'::"text"]))),
    CONSTRAINT "optimization_runs_pause_max_wait_positive" CHECK (("pause_max_wait_minutes" > 0)),
    CONSTRAINT "optimization_runs_probe_interval_positive" CHECK (("probe_interval_seconds" > 0))
);


ALTER TABLE "public"."optimization_runs" OWNER TO "postgres";


COMMENT ON COLUMN "public"."optimization_runs"."seed_score" IS 'Seed (Candidate 0) full-set overall score, persisted at the completion transition (#113). Null for runs completed before this column existed — the read surface must claim no lift in that case.';



CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text" NOT NULL
);


ALTER TABLE "public"."organizations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."overage_invoice_lines" (
    "org_id" "uuid" NOT NULL,
    "period_start" timestamp with time zone NOT NULL,
    "meter" "text" NOT NULL,
    "quantity" bigint NOT NULL,
    "unit_usd" numeric(12,6),
    "stripe_invoice_item_id" "text",
    "invoiced_quantity" bigint DEFAULT 0 NOT NULL,
    "dirty" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "overage_invoice_lines_meter_check" CHECK (("meter" = ANY (ARRAY['points'::"text", 'runs'::"text"]))),
    CONSTRAINT "overage_invoice_lines_quantity_check" CHECK (("quantity" >= 0))
);


ALTER TABLE "public"."overage_invoice_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."paid_invoices" (
    "stripe_invoice_id" "text" NOT NULL,
    "org_id" "uuid" NOT NULL,
    "paid_at" timestamp with time zone NOT NULL,
    "amount_usd" numeric(14,2) DEFAULT 0 NOT NULL,
    "stripe_payment_intent_id" "text",
    "reversed_at" timestamp with time zone,
    "reversal_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "paid_invoices_amount_usd_check" CHECK (("amount_usd" >= (0)::numeric)),
    CONSTRAINT "paid_invoices_reversal_reason_check" CHECK ((("reversal_reason" IS NULL) OR ("reversal_reason" = ANY (ARRAY['refund'::"text", 'dispute'::"text", 'uncollectible'::"text", 'void'::"text"]))))
);


ALTER TABLE "public"."paid_invoices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."point_ledger" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "entry_type" "text" NOT NULL,
    "points" bigint NOT NULL,
    "eval_run_id" "uuid",
    "period_start" timestamp with time zone NOT NULL,
    "period_end" timestamp with time zone NOT NULL,
    "meta" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "opt_run_id" "uuid",
    CONSTRAINT "point_ledger_entry_type_check" CHECK (("entry_type" = ANY (ARRAY['grant'::"text", 'reserve'::"text", 'settle'::"text", 'release'::"text", 'upgrade'::"text"]))),
    CONSTRAINT "point_ledger_points_check" CHECK (("points" >= 0))
);


ALTER TABLE "public"."point_ledger" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_keys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "secret_id" "uuid" NOT NULL,
    "last4" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "provider_keys_provider_check" CHECK (("provider" = ANY (ARRAY['anthropic'::"text", 'openai'::"text", 'google'::"text", 'mistral'::"text"])))
);


ALTER TABLE "public"."provider_keys" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rate_limit_hits" (
    "hashed_key" "text" NOT NULL,
    "window_start" timestamp with time zone NOT NULL,
    "surface" "text" NOT NULL,
    "keytype" "text" NOT NULL,
    "count" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."rate_limit_hits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rollout_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "rollout_id" "uuid" NOT NULL,
    "criterion_name" "text" NOT NULL,
    "score" numeric(4,3) NOT NULL,
    "reasoning" "text" NOT NULL
);


ALTER TABLE "public"."rollout_results" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rubrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_by" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "scenario_description" "text" NOT NULL,
    "expected_outcome" "text" NOT NULL,
    "evaluation_mode" "public"."evaluation_mode" NOT NULL,
    "grounding_context" "text",
    "criteria" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    CONSTRAINT "rubrics_criteria_check" CHECK (("jsonb_typeof"("criteria") = 'array'::"text"))
);


ALTER TABLE "public"."rubrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."schedule_inputs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "schedule_id" "uuid" NOT NULL,
    "row_index" integer NOT NULL,
    "user_input" "text" NOT NULL,
    "expected_output" "text",
    "retrieval_context" "text"
);


ALTER TABLE "public"."schedule_inputs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "rubric_id" "uuid" NOT NULL,
    "connection_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "eval_type" "text" DEFAULT 'tabular'::"text" NOT NULL,
    "frequency" "text" NOT NULL,
    "local_hour" smallint,
    "days_of_week" smallint[],
    "day_of_month" smallint,
    "timezone" "text" DEFAULT 'UTC'::"text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "notification_emails" "text"[],
    "next_run_at" timestamp with time zone,
    "last_run_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "window_minutes" integer,
    "max_rows" integer,
    CONSTRAINT "schedules_day_of_month_check" CHECK ((("day_of_month" >= 1) AND ("day_of_month" <= 28))),
    CONSTRAINT "schedules_frequency_check" CHECK (("frequency" = ANY (ARRAY['hourly'::"text", 'daily'::"text", 'weekly'::"text", 'monthly'::"text"]))),
    CONSTRAINT "schedules_local_hour_check" CHECK ((("local_hour" >= 0) AND ("local_hour" <= 23))),
    CONSTRAINT "schedules_max_rows_check" CHECK ((("max_rows" IS NULL) OR ("max_rows" > 0))),
    CONSTRAINT "schedules_window_minutes_check" CHECK ((("window_minutes" IS NULL) OR ("window_minutes" > 0)))
);


ALTER TABLE "public"."schedules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."worker_config" (
    "id" smallint DEFAULT 1 NOT NULL,
    "wake_url" "text",
    "wake_secret" "text",
    "managed_threshold_url" "text",
    "managed_threshold_secret" "text",
    "retention_url" "text",
    "retention_secret" "text",
    CONSTRAINT "worker_config_id_check" CHECK (("id" = 1))
);


ALTER TABLE "public"."worker_config" OWNER TO "postgres";


ALTER TABLE ONLY "public"."access_code_redemptions"
    ADD CONSTRAINT "access_code_redemptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."access_codes"
    ADD CONSTRAINT "access_codes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billing_events"
    ADD CONSTRAINT "billing_events_pkey" PRIMARY KEY ("stripe_event_id");



ALTER TABLE ONLY "public"."billing_notifications"
    ADD CONSTRAINT "billing_notifications_pkey" PRIMARY KEY ("org_id", "kind", "period_start");



ALTER TABLE ONLY "public"."billing_settings"
    ADD CONSTRAINT "billing_settings_pkey" PRIMARY KEY ("org_id");



ALTER TABLE ONLY "public"."connections"
    ADD CONSTRAINT "connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("org_id");



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_stripe_customer_id_key" UNIQUE ("stripe_customer_id");



ALTER TABLE ONLY "public"."eval_run_results"
    ADD CONSTRAINT "eval_run_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."eval_run_results"
    ADD CONSTRAINT "eval_run_results_unique" UNIQUE ("eval_run_id", "row_index", "criterion_name");



ALTER TABLE ONLY "public"."eval_run_rows"
    ADD CONSTRAINT "eval_run_rows_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."eval_run_rows"
    ADD CONSTRAINT "eval_run_rows_unique" UNIQUE ("eval_run_id", "row_index");



ALTER TABLE ONLY "public"."eval_runs"
    ADD CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."managed_invoice_lines"
    ADD CONSTRAINT "managed_invoice_lines_pkey" PRIMARY KEY ("org_id", "period_start", "provider", "model");



ALTER TABLE ONLY "public"."managed_spend_ledger"
    ADD CONSTRAINT "managed_spend_ledger_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_pkey" PRIMARY KEY ("org_id", "user_id");



ALTER TABLE ONLY "public"."optimization_candidates"
    ADD CONSTRAINT "optimization_candidates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."optimization_inputs"
    ADD CONSTRAINT "optimization_inputs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."optimization_inputs"
    ADD CONSTRAINT "optimization_inputs_unique" UNIQUE ("opt_run_id", "instance_index");



ALTER TABLE ONLY "public"."optimization_rollouts"
    ADD CONSTRAINT "optimization_rollouts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."optimization_rollouts"
    ADD CONSTRAINT "optimization_rollouts_unique" UNIQUE ("candidate_id", "instance_index", "phase");



ALTER TABLE ONLY "public"."optimization_run_ledger"
    ADD CONSTRAINT "optimization_run_ledger_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."optimization_runs"
    ADD CONSTRAINT "optimization_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."overage_invoice_lines"
    ADD CONSTRAINT "overage_invoice_lines_pkey" PRIMARY KEY ("org_id", "period_start", "meter");



ALTER TABLE ONLY "public"."paid_invoices"
    ADD CONSTRAINT "paid_invoices_pkey" PRIMARY KEY ("stripe_invoice_id");



ALTER TABLE ONLY "public"."point_ledger"
    ADD CONSTRAINT "point_ledger_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_keys"
    ADD CONSTRAINT "provider_keys_org_id_provider_key" UNIQUE ("org_id", "provider");



ALTER TABLE ONLY "public"."provider_keys"
    ADD CONSTRAINT "provider_keys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rate_limit_hits"
    ADD CONSTRAINT "rate_limit_hits_pkey" PRIMARY KEY ("hashed_key", "window_start");



ALTER TABLE ONLY "public"."rollout_results"
    ADD CONSTRAINT "rollout_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rollout_results"
    ADD CONSTRAINT "rollout_results_unique" UNIQUE ("rollout_id", "criterion_name");



ALTER TABLE ONLY "public"."rubrics"
    ADD CONSTRAINT "rubrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedule_inputs"
    ADD CONSTRAINT "schedule_inputs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedule_inputs"
    ADD CONSTRAINT "schedule_inputs_unique" UNIQUE ("schedule_id", "row_index");



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."worker_config"
    ADD CONSTRAINT "worker_config_pkey" PRIMARY KEY ("id");



CREATE INDEX "access_code_redemptions_access_code_id_idx" ON "public"."access_code_redemptions" USING "btree" ("access_code_id");



CREATE INDEX "access_code_redemptions_user_id_idx" ON "public"."access_code_redemptions" USING "btree" ("user_id");



CREATE UNIQUE INDEX "access_codes_code_lower_idx" ON "public"."access_codes" USING "btree" ("lower"("code"));



CREATE INDEX "connections_org_id_created_at_idx" ON "public"."connections" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "customers_subscription_id_idx" ON "public"."customers" USING "btree" ("stripe_subscription_id");



CREATE INDEX "eval_run_results_run_idx" ON "public"."eval_run_results" USING "btree" ("eval_run_id", "row_index");



CREATE INDEX "eval_run_rows_run_idx" ON "public"."eval_run_rows" USING "btree" ("eval_run_id", "row_index");



CREATE INDEX "eval_runs_deleted_at_idx" ON "public"."eval_runs" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NOT NULL);



CREATE INDEX "eval_runs_queued_updated_idx" ON "public"."eval_runs" USING "btree" ("updated_at") WHERE ("status" = 'queued'::"public"."eval_run_status");



CREATE INDEX "eval_runs_rubric_idx" ON "public"."eval_runs" USING "btree" ("rubric_id", "created_at" DESC);



CREATE INDEX "eval_runs_running_updated_idx" ON "public"."eval_runs" USING "btree" ("updated_at") WHERE ("status" = 'running'::"public"."eval_run_status");



CREATE INDEX "eval_runs_schedule_idx" ON "public"."eval_runs" USING "btree" ("schedule_id", "created_at" DESC);



CREATE INDEX "invitations_org_id_idx" ON "public"."invitations" USING "btree" ("org_id");



CREATE UNIQUE INDEX "invitations_pending_unique" ON "public"."invitations" USING "btree" ("org_id", "email") WHERE ("accepted_at" IS NULL);



CREATE INDEX "managed_invoice_lines_uninvoiced_idx" ON "public"."managed_invoice_lines" USING "btree" ("org_id", "period_start") WHERE ("accrued_usd" > "invoiced_usd");



CREATE INDEX "managed_spend_ledger_eval_run_idx" ON "public"."managed_spend_ledger" USING "btree" ("eval_run_id") WHERE ("eval_run_id" IS NOT NULL);



CREATE INDEX "managed_spend_ledger_opt_run_idx" ON "public"."managed_spend_ledger" USING "btree" ("opt_run_id") WHERE ("opt_run_id" IS NOT NULL);



CREATE INDEX "managed_spend_ledger_org_period_idx" ON "public"."managed_spend_ledger" USING "btree" ("org_id", "period_start", "created_at" DESC);



CREATE INDEX "memberships_user_id_idx" ON "public"."memberships" USING "btree" ("user_id");



CREATE UNIQUE INDEX "optimization_candidates_iteration_unique" ON "public"."optimization_candidates" USING "btree" ("opt_run_id", "iteration") WHERE ("iteration" IS NOT NULL);



CREATE INDEX "optimization_candidates_run_idx" ON "public"."optimization_candidates" USING "btree" ("opt_run_id", "generation");



CREATE INDEX "optimization_inputs_run_idx" ON "public"."optimization_inputs" USING "btree" ("opt_run_id", "instance_index");



CREATE INDEX "optimization_rollouts_candidate_idx" ON "public"."optimization_rollouts" USING "btree" ("candidate_id", "phase");



CREATE UNIQUE INDEX "optimization_run_ledger_one_grant_per_period" ON "public"."optimization_run_ledger" USING "btree" ("org_id", "period_start") WHERE ("entry_type" = 'grant'::"text");



CREATE UNIQUE INDEX "optimization_run_ledger_one_release_per_run" ON "public"."optimization_run_ledger" USING "btree" ("opt_run_id") WHERE ("entry_type" = 'release'::"text");



CREATE UNIQUE INDEX "optimization_run_ledger_one_reserve_per_run" ON "public"."optimization_run_ledger" USING "btree" ("opt_run_id") WHERE ("entry_type" = 'reserve'::"text");



CREATE UNIQUE INDEX "optimization_run_ledger_one_settle_per_run" ON "public"."optimization_run_ledger" USING "btree" ("opt_run_id") WHERE ("entry_type" = 'settle'::"text");



CREATE INDEX "optimization_run_ledger_org_period_idx" ON "public"."optimization_run_ledger" USING "btree" ("org_id", "period_start", "created_at" DESC);



CREATE INDEX "optimization_runs_deleted_at_idx" ON "public"."optimization_runs" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NOT NULL);



CREATE UNIQUE INDEX "optimization_runs_one_active_per_org" ON "public"."optimization_runs" USING "btree" ("org_id") WHERE ("status" = ANY (ARRAY['queued'::"public"."optimization_run_status", 'running'::"public"."optimization_run_status", 'paused'::"public"."optimization_run_status"]));



CREATE INDEX "optimization_runs_org_idx" ON "public"."optimization_runs" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "optimization_runs_running_updated_idx" ON "public"."optimization_runs" USING "btree" ("updated_at") WHERE ("status" = 'running'::"public"."optimization_run_status");



CREATE INDEX "paid_invoices_org_live_idx" ON "public"."paid_invoices" USING "btree" ("org_id") WHERE ("reversed_at" IS NULL);



CREATE INDEX "paid_invoices_payment_intent_idx" ON "public"."paid_invoices" USING "btree" ("stripe_payment_intent_id") WHERE ("stripe_payment_intent_id" IS NOT NULL);



CREATE UNIQUE INDEX "point_ledger_one_grant_per_period" ON "public"."point_ledger" USING "btree" ("org_id", "period_start") WHERE ("entry_type" = 'grant'::"text");



CREATE UNIQUE INDEX "point_ledger_one_opt_release_per_run" ON "public"."point_ledger" USING "btree" ("opt_run_id") WHERE (("entry_type" = 'release'::"text") AND ("opt_run_id" IS NOT NULL));



CREATE UNIQUE INDEX "point_ledger_one_opt_reserve_per_run" ON "public"."point_ledger" USING "btree" ("opt_run_id") WHERE (("entry_type" = 'reserve'::"text") AND ("opt_run_id" IS NOT NULL));



CREATE UNIQUE INDEX "point_ledger_one_opt_settle_per_run" ON "public"."point_ledger" USING "btree" ("opt_run_id") WHERE (("entry_type" = 'settle'::"text") AND ("opt_run_id" IS NOT NULL));



CREATE UNIQUE INDEX "point_ledger_one_release_per_run" ON "public"."point_ledger" USING "btree" ("eval_run_id") WHERE ("entry_type" = 'release'::"text");



CREATE UNIQUE INDEX "point_ledger_one_reserve_per_run" ON "public"."point_ledger" USING "btree" ("eval_run_id") WHERE ("entry_type" = 'reserve'::"text");



CREATE UNIQUE INDEX "point_ledger_one_settle_per_run" ON "public"."point_ledger" USING "btree" ("eval_run_id") WHERE ("entry_type" = 'settle'::"text");



CREATE INDEX "point_ledger_org_period_idx" ON "public"."point_ledger" USING "btree" ("org_id", "period_start", "created_at" DESC);



CREATE INDEX "provider_keys_org_id_idx" ON "public"."provider_keys" USING "btree" ("org_id");



CREATE INDEX "rate_limit_hits_window_start_idx" ON "public"."rate_limit_hits" USING "btree" ("window_start");



CREATE INDEX "rollout_results_rollout_idx" ON "public"."rollout_results" USING "btree" ("rollout_id");



CREATE INDEX "rubrics_org_id_created_at_idx" ON "public"."rubrics" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "schedule_inputs_schedule_idx" ON "public"."schedule_inputs" USING "btree" ("schedule_id", "row_index");



CREATE INDEX "schedules_due_idx" ON "public"."schedules" USING "btree" ("next_run_at") WHERE "enabled";



CREATE INDEX "schedules_org_id_created_at_idx" ON "public"."schedules" USING "btree" ("org_id", "created_at" DESC);



CREATE OR REPLACE TRIGGER "connections_delete_secret_trigger" AFTER DELETE ON "public"."connections" FOR EACH ROW EXECUTE FUNCTION "public"."connections_delete_secret"();



CREATE OR REPLACE TRIGGER "memberships_min_one_admin" BEFORE DELETE OR UPDATE ON "public"."memberships" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_min_one_admin"();



CREATE OR REPLACE TRIGGER "provider_keys_delete_secret_trigger" AFTER DELETE ON "public"."provider_keys" FOR EACH ROW EXECUTE FUNCTION "public"."provider_keys_delete_secret"();



ALTER TABLE ONLY "public"."access_code_redemptions"
    ADD CONSTRAINT "access_code_redemptions_access_code_id_fkey" FOREIGN KEY ("access_code_id") REFERENCES "public"."access_codes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."access_code_redemptions"
    ADD CONSTRAINT "access_code_redemptions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."access_code_redemptions"
    ADD CONSTRAINT "access_code_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."billing_notifications"
    ADD CONSTRAINT "billing_notifications_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."billing_settings"
    ADD CONSTRAINT "billing_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."connections"
    ADD CONSTRAINT "connections_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."connections"
    ADD CONSTRAINT "connections_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."eval_run_results"
    ADD CONSTRAINT "eval_run_results_eval_run_id_fkey" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."eval_run_rows"
    ADD CONSTRAINT "eval_run_rows_eval_run_id_fkey" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."eval_runs"
    ADD CONSTRAINT "eval_runs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."eval_runs"
    ADD CONSTRAINT "eval_runs_rubric_id_fkey" FOREIGN KEY ("rubric_id") REFERENCES "public"."rubrics"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."eval_runs"
    ADD CONSTRAINT "eval_runs_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."managed_invoice_lines"
    ADD CONSTRAINT "managed_invoice_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."managed_spend_ledger"
    ADD CONSTRAINT "managed_spend_ledger_eval_run_id_fkey" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."managed_spend_ledger"
    ADD CONSTRAINT "managed_spend_ledger_opt_run_id_fkey" FOREIGN KEY ("opt_run_id") REFERENCES "public"."optimization_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."managed_spend_ledger"
    ADD CONSTRAINT "managed_spend_ledger_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."optimization_candidates"
    ADD CONSTRAINT "optimization_candidates_merged_from_id_fkey" FOREIGN KEY ("merged_from_id") REFERENCES "public"."optimization_candidates"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."optimization_candidates"
    ADD CONSTRAINT "optimization_candidates_opt_run_id_fkey" FOREIGN KEY ("opt_run_id") REFERENCES "public"."optimization_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."optimization_candidates"
    ADD CONSTRAINT "optimization_candidates_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."optimization_candidates"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."optimization_inputs"
    ADD CONSTRAINT "optimization_inputs_opt_run_id_fkey" FOREIGN KEY ("opt_run_id") REFERENCES "public"."optimization_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."optimization_rollouts"
    ADD CONSTRAINT "optimization_rollouts_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "public"."optimization_candidates"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."optimization_run_ledger"
    ADD CONSTRAINT "optimization_run_ledger_opt_run_id_fkey" FOREIGN KEY ("opt_run_id") REFERENCES "public"."optimization_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."optimization_run_ledger"
    ADD CONSTRAINT "optimization_run_ledger_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."optimization_runs"
    ADD CONSTRAINT "optimization_runs_best_candidate_fkey" FOREIGN KEY ("best_candidate_id") REFERENCES "public"."optimization_candidates"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."optimization_runs"
    ADD CONSTRAINT "optimization_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."optimization_runs"
    ADD CONSTRAINT "optimization_runs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."optimization_runs"
    ADD CONSTRAINT "optimization_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."optimization_runs"
    ADD CONSTRAINT "optimization_runs_rubric_id_fkey" FOREIGN KEY ("rubric_id") REFERENCES "public"."rubrics"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."overage_invoice_lines"
    ADD CONSTRAINT "overage_invoice_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."paid_invoices"
    ADD CONSTRAINT "paid_invoices_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."point_ledger"
    ADD CONSTRAINT "point_ledger_eval_run_id_fkey" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."point_ledger"
    ADD CONSTRAINT "point_ledger_opt_run_id_fkey" FOREIGN KEY ("opt_run_id") REFERENCES "public"."optimization_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."point_ledger"
    ADD CONSTRAINT "point_ledger_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_keys"
    ADD CONSTRAINT "provider_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."provider_keys"
    ADD CONSTRAINT "provider_keys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rollout_results"
    ADD CONSTRAINT "rollout_results_rollout_id_fkey" FOREIGN KEY ("rollout_id") REFERENCES "public"."optimization_rollouts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rubrics"
    ADD CONSTRAINT "rubrics_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rubrics"
    ADD CONSTRAINT "rubrics_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedule_inputs"
    ADD CONSTRAINT "schedule_inputs_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_rubric_id_fkey" FOREIGN KEY ("rubric_id") REFERENCES "public"."rubrics"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE "public"."access_code_redemptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."access_codes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."billing_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."billing_notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."billing_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."connections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."eval_run_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."eval_run_rows" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."eval_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."invitations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."managed_invoice_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."managed_spend_ledger" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."memberships" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."optimization_candidates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."optimization_inputs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."optimization_rollouts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."optimization_run_ledger" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."optimization_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."overage_invoice_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."paid_invoices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."point_ledger" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."provider_keys" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rate_limit_hits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rollout_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rubrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."schedule_inputs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."schedules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."worker_config" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";








GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

















































































































































































REVOKE ALL ON FUNCTION "public"."accrue_managed_spend"("p_org_id" "uuid", "p_amount_usd" numeric, "p_provider" "text", "p_model" "text", "p_input_tokens" bigint, "p_output_tokens" bigint, "p_input_unit_usd" numeric, "p_output_unit_usd" numeric, "p_markup_pct" numeric, "p_call_kind" "text", "p_eval_run_id" "uuid", "p_opt_run_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accrue_managed_spend"("p_org_id" "uuid", "p_amount_usd" numeric, "p_provider" "text", "p_model" "text", "p_input_tokens" bigint, "p_output_tokens" bigint, "p_input_unit_usd" numeric, "p_output_unit_usd" numeric, "p_markup_pct" numeric, "p_call_kind" "text", "p_eval_run_id" "uuid", "p_opt_run_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."ack_eval_run_message"("p_msg_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ack_eval_run_message"("p_msg_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."ack_eval_run_message"("p_msg_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."ack_eval_run_message"("p_msg_id" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_access_code"("p_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_access_code"("p_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."claim_access_code"("p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_access_code"("p_code" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."compute_next_run_at"("p_frequency" "text", "p_local_hour" smallint, "p_days_of_week" smallint[], "p_day_of_month" smallint, "p_timezone" "text", "p_after" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."compute_next_run_at"("p_frequency" "text", "p_local_hour" smallint, "p_days_of_week" smallint[], "p_day_of_month" smallint, "p_timezone" "text", "p_after" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."compute_next_run_at"("p_frequency" "text", "p_local_hour" smallint, "p_days_of_week" smallint[], "p_day_of_month" smallint, "p_timezone" "text", "p_after" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."compute_next_run_at"("p_frequency" "text", "p_local_hour" smallint, "p_days_of_week" smallint[], "p_day_of_month" smallint, "p_timezone" "text", "p_after" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."connections_delete_secret"() TO "anon";
GRANT ALL ON FUNCTION "public"."connections_delete_secret"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."connections_delete_secret"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_connection_secret"("p_secret" "text", "p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_connection_secret"("p_secret" "text", "p_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_connection_secret"("p_secret" "text", "p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_connection_secret"("p_secret" "text", "p_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."dashboard_runs"("p_org_id" "uuid", "p_window_start" timestamp with time zone, "p_n" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."dashboard_runs"("p_org_id" "uuid", "p_window_start" timestamp with time zone, "p_n" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_connection_secret"("p_secret_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_connection_secret"("p_secret_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_connection_secret"("p_secret_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_connection_secret"("p_secret_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."dequeue_eval_run_message"("vt_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."dequeue_eval_run_message"("vt_seconds" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."dequeue_eval_run_message"("vt_seconds" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dequeue_eval_run_message"("vt_seconds" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."enforce_min_one_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_min_one_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_min_one_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enqueue_eval_run"("run_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enqueue_eval_run"("run_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."enqueue_eval_run"("run_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."enqueue_eval_run"("run_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."ensure_optimization_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ensure_optimization_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."ensure_optimization_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_optimization_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."ensure_point_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ensure_point_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."ensure_point_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_point_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."expire_runs_before"("p_org_id" "uuid", "p_cutoff" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."expire_runs_before"("p_org_id" "uuid", "p_cutoff" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_connection_auth"("p_secret_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_connection_auth"("p_secret_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_connection_auth"("p_secret_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_connection_auth"("p_secret_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_provider_secret"("p_secret_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_provider_secret"("p_secret_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."increment_rate_limit"("p_hashed_key" "text", "p_window_start" timestamp with time zone, "p_surface" "text", "p_keytype" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."increment_rate_limit"("p_hashed_key" "text", "p_window_start" timestamp with time zone, "p_surface" "text", "p_keytype" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."increment_rate_limit"("p_hashed_key" "text", "p_window_start" timestamp with time zone, "p_surface" "text", "p_keytype" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_rate_limit"("p_hashed_key" "text", "p_window_start" timestamp with time zone, "p_surface" "text", "p_keytype" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."managed_invoice_candidate_orgs"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."managed_invoice_candidate_orgs"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."managed_spend_total"("p_org_id" "uuid", "p_period_start" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."managed_spend_total"("p_org_id" "uuid", "p_period_start" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."managed_uninvoiced_total"("p_org_id" "uuid", "p_period_start" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."managed_uninvoiced_total"("p_org_id" "uuid", "p_period_start" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."mark_managed_line_invoiced"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_provider" "text", "p_model" "text", "p_amount" numeric, "p_invoice_id" "text", "p_item_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_managed_line_invoiced"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_provider" "text", "p_model" "text", "p_amount" numeric, "p_invoice_id" "text", "p_item_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."optimization_run_balance"("p_org_id" "uuid", "p_period_start" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."optimization_run_balance"("p_org_id" "uuid", "p_period_start" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."optimization_run_balance"("p_org_id" "uuid", "p_period_start" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."optimization_run_balance"("p_org_id" "uuid", "p_period_start" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."point_balance"("p_org_id" "uuid", "p_period_start" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."point_balance"("p_org_id" "uuid", "p_period_start" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."point_balance"("p_org_id" "uuid", "p_period_start" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."point_balance"("p_org_id" "uuid", "p_period_start" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."projected_overage_usd"("p_point_balance" bigint, "p_point_unit_usd" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."projected_overage_usd"("p_point_balance" bigint, "p_point_unit_usd" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."projected_overage_usd"("p_point_balance" bigint, "p_point_unit_usd" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."projected_overage_usd"("p_point_balance" bigint, "p_point_unit_usd" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."provider_keys_delete_secret"() TO "anon";
GRANT ALL ON FUNCTION "public"."provider_keys_delete_secret"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."provider_keys_delete_secret"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."purge_expired_runs"("p_grace_days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_expired_runs"("p_grace_days" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reap_stale_eval_runs"("p_threshold_minutes" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reap_stale_eval_runs"("p_threshold_minutes" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."reap_stale_eval_runs"("p_threshold_minutes" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."reap_stale_eval_runs"("p_threshold_minutes" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reap_stale_optimization_runs"("p_threshold_minutes" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reap_stale_optimization_runs"("p_threshold_minutes" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."reap_stale_optimization_runs"("p_threshold_minutes" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."reap_stale_optimization_runs"("p_threshold_minutes" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reconcile_plan_grants"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included_points" bigint, "p_included_runs" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reconcile_plan_grants"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included_points" bigint, "p_included_runs" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."reconcile_plan_grants"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included_points" bigint, "p_included_runs" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."reconcile_plan_grants"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included_points" bigint, "p_included_runs" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."refresh_managed_invoice_lines"("p_org_id" "uuid", "p_period_start" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_managed_invoice_lines"("p_org_id" "uuid", "p_period_start" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."refresh_overage_line"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_meter" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_overage_line"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_meter" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_overage_line"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_meter" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_overage_line"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_meter" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_access_code_claim"("p_access_code_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_access_code_claim"("p_access_code_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."release_access_code_claim"("p_access_code_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."release_access_code_claim"("p_access_code_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_managed_reservation"("p_eval_run_id" "uuid", "p_opt_run_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_managed_reservation"("p_eval_run_id" "uuid", "p_opt_run_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reserve_eval_points"("p_org_id" "uuid", "p_run_id" "uuid", "p_cost" bigint, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint, "p_meta" "jsonb", "p_point_unit_usd" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reserve_eval_points"("p_org_id" "uuid", "p_run_id" "uuid", "p_cost" bigint, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint, "p_meta" "jsonb", "p_point_unit_usd" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."reserve_eval_points"("p_org_id" "uuid", "p_run_id" "uuid", "p_cost" bigint, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint, "p_meta" "jsonb", "p_point_unit_usd" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."reserve_eval_points"("p_org_id" "uuid", "p_run_id" "uuid", "p_cost" bigint, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint, "p_meta" "jsonb", "p_point_unit_usd" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reserve_managed_spend"("p_org_id" "uuid", "p_estimate_usd" numeric, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_cap_usd" numeric, "p_markup_pct" numeric, "p_eval_run_id" "uuid", "p_opt_run_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reserve_managed_spend"("p_org_id" "uuid", "p_estimate_usd" numeric, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_cap_usd" numeric, "p_markup_pct" numeric, "p_eval_run_id" "uuid", "p_opt_run_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reserve_optimization_points"("p_org_id" "uuid", "p_run_id" "uuid", "p_cost" bigint, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint, "p_meta" "jsonb", "p_point_unit_usd" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reserve_optimization_points"("p_org_id" "uuid", "p_run_id" "uuid", "p_cost" bigint, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint, "p_meta" "jsonb", "p_point_unit_usd" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."reserve_optimization_points"("p_org_id" "uuid", "p_run_id" "uuid", "p_cost" bigint, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint, "p_meta" "jsonb", "p_point_unit_usd" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."reserve_optimization_points"("p_org_id" "uuid", "p_run_id" "uuid", "p_cost" bigint, "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint, "p_meta" "jsonb", "p_point_unit_usd" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reserve_optimization_run"("p_org_id" "uuid", "p_run_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reserve_optimization_run"("p_org_id" "uuid", "p_run_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."reserve_optimization_run"("p_org_id" "uuid", "p_run_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."reserve_optimization_run"("p_org_id" "uuid", "p_run_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."restore_runs_since"("p_org_id" "uuid", "p_cutoff" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."restore_runs_since"("p_org_id" "uuid", "p_cutoff" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."retention_candidate_orgs"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."retention_candidate_orgs"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_provider_key"("p_org_id" "uuid", "p_provider" "text", "p_secret" "text", "p_last4" "text", "p_created_by" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_provider_key"("p_org_id" "uuid", "p_provider" "text", "p_secret" "text", "p_last4" "text", "p_created_by" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."settle_eval_run_points"("p_run_id" "uuid", "p_outcome" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_eval_run_points"("p_run_id" "uuid", "p_outcome" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."settle_eval_run_points"("p_run_id" "uuid", "p_outcome" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."settle_eval_run_points"("p_run_id" "uuid", "p_outcome" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."settle_optimization_run"("p_run_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_optimization_run"("p_run_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."settle_optimization_run"("p_run_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."settle_optimization_run"("p_run_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."settle_optimization_run_points"("p_run_id" "uuid", "p_outcome" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_optimization_run_points"("p_run_id" "uuid", "p_outcome" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."settle_optimization_run_points"("p_run_id" "uuid", "p_outcome" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."settle_optimization_run_points"("p_run_id" "uuid", "p_outcome" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."tick_managed_threshold"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."tick_managed_threshold"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."tick_retention"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."tick_retention"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."tick_schedules"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."tick_schedules"() TO "anon";
GRANT ALL ON FUNCTION "public"."tick_schedules"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."tick_schedules"() TO "service_role";
























GRANT ALL ON TABLE "public"."access_code_redemptions" TO "anon";
GRANT ALL ON TABLE "public"."access_code_redemptions" TO "authenticated";
GRANT ALL ON TABLE "public"."access_code_redemptions" TO "service_role";



GRANT ALL ON TABLE "public"."access_codes" TO "anon";
GRANT ALL ON TABLE "public"."access_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."access_codes" TO "service_role";



GRANT ALL ON TABLE "public"."billing_events" TO "anon";
GRANT ALL ON TABLE "public"."billing_events" TO "authenticated";
GRANT ALL ON TABLE "public"."billing_events" TO "service_role";



GRANT ALL ON TABLE "public"."billing_notifications" TO "service_role";



GRANT ALL ON TABLE "public"."billing_settings" TO "service_role";



GRANT ALL ON TABLE "public"."connections" TO "anon";
GRANT ALL ON TABLE "public"."connections" TO "authenticated";
GRANT ALL ON TABLE "public"."connections" TO "service_role";



GRANT ALL ON TABLE "public"."customers" TO "anon";
GRANT ALL ON TABLE "public"."customers" TO "authenticated";
GRANT ALL ON TABLE "public"."customers" TO "service_role";



GRANT ALL ON TABLE "public"."eval_run_results" TO "anon";
GRANT ALL ON TABLE "public"."eval_run_results" TO "authenticated";
GRANT ALL ON TABLE "public"."eval_run_results" TO "service_role";



GRANT ALL ON TABLE "public"."eval_run_rows" TO "anon";
GRANT ALL ON TABLE "public"."eval_run_rows" TO "authenticated";
GRANT ALL ON TABLE "public"."eval_run_rows" TO "service_role";



GRANT ALL ON TABLE "public"."eval_runs" TO "anon";
GRANT ALL ON TABLE "public"."eval_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."eval_runs" TO "service_role";



GRANT ALL ON TABLE "public"."invitations" TO "anon";
GRANT ALL ON TABLE "public"."invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."invitations" TO "service_role";



GRANT ALL ON TABLE "public"."managed_invoice_lines" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."managed_spend_ledger" TO "service_role";



GRANT ALL ON TABLE "public"."memberships" TO "anon";
GRANT ALL ON TABLE "public"."memberships" TO "authenticated";
GRANT ALL ON TABLE "public"."memberships" TO "service_role";



GRANT ALL ON TABLE "public"."optimization_candidates" TO "anon";
GRANT ALL ON TABLE "public"."optimization_candidates" TO "authenticated";
GRANT ALL ON TABLE "public"."optimization_candidates" TO "service_role";



GRANT ALL ON TABLE "public"."optimization_inputs" TO "anon";
GRANT ALL ON TABLE "public"."optimization_inputs" TO "authenticated";
GRANT ALL ON TABLE "public"."optimization_inputs" TO "service_role";



GRANT ALL ON TABLE "public"."optimization_rollouts" TO "anon";
GRANT ALL ON TABLE "public"."optimization_rollouts" TO "authenticated";
GRANT ALL ON TABLE "public"."optimization_rollouts" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."optimization_run_ledger" TO "service_role";



GRANT ALL ON TABLE "public"."optimization_runs" TO "anon";
GRANT ALL ON TABLE "public"."optimization_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."optimization_runs" TO "service_role";



GRANT ALL ON TABLE "public"."organizations" TO "anon";
GRANT ALL ON TABLE "public"."organizations" TO "authenticated";
GRANT ALL ON TABLE "public"."organizations" TO "service_role";



GRANT ALL ON TABLE "public"."overage_invoice_lines" TO "service_role";



GRANT ALL ON TABLE "public"."paid_invoices" TO "anon";
GRANT ALL ON TABLE "public"."paid_invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."paid_invoices" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."point_ledger" TO "service_role";



GRANT ALL ON TABLE "public"."provider_keys" TO "anon";
GRANT ALL ON TABLE "public"."provider_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_keys" TO "service_role";



GRANT ALL ON TABLE "public"."rate_limit_hits" TO "anon";
GRANT ALL ON TABLE "public"."rate_limit_hits" TO "authenticated";
GRANT ALL ON TABLE "public"."rate_limit_hits" TO "service_role";



GRANT ALL ON TABLE "public"."rollout_results" TO "anon";
GRANT ALL ON TABLE "public"."rollout_results" TO "authenticated";
GRANT ALL ON TABLE "public"."rollout_results" TO "service_role";



GRANT ALL ON TABLE "public"."rubrics" TO "anon";
GRANT ALL ON TABLE "public"."rubrics" TO "authenticated";
GRANT ALL ON TABLE "public"."rubrics" TO "service_role";



GRANT ALL ON TABLE "public"."schedule_inputs" TO "anon";
GRANT ALL ON TABLE "public"."schedule_inputs" TO "authenticated";
GRANT ALL ON TABLE "public"."schedule_inputs" TO "service_role";



GRANT ALL ON TABLE "public"."schedules" TO "anon";
GRANT ALL ON TABLE "public"."schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."schedules" TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";



GRANT ALL ON TABLE "public"."worker_config" TO "anon";
GRANT ALL ON TABLE "public"."worker_config" TO "authenticated";
GRANT ALL ON TABLE "public"."worker_config" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
































-- ── Imperative pieces (not carried by a schema dump) ─────────────────────────

-- The eval-run scheduling queue (pg_cron -> enqueue_eval_run -> pgmq; the worker
-- poll loop dispatches to Temporal, ADR-0006).
select pgmq.create('eval_runs');

-- Scheduled jobs.
select cron.schedule('tick-schedules', '* * * * *', $$ select public.tick_schedules(); $$);
select cron.schedule('tick-managed-threshold', '* * * * *', $$ select public.tick_managed_threshold(); $$);
select cron.schedule(
  'rate-limit-sweep',
  '17 3 * * *',
  $$ delete from public.rate_limit_hits where window_start < now() - interval '1 day'; $$
);
select cron.schedule('tick-retention',      '23 2 * * *', $$ select public.tick_retention(); $$);
select cron.schedule('purge-expired-runs',  '47 3 * * *', $$ select public.purge_expired_runs(); $$);

-- Mirror each new auth user into public.users (see handle_new_user above).
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Security hardening the schema dump cannot express ────────────────────────
-- Supabase's ALTER DEFAULT PRIVILEGES auto-grants anon/authenticated on every
-- new public object at creation time, so the revokes the old migration chain
-- carried (point-ledger hardening, vault wrapper lockdown #184, billing RPC and
-- table lockdowns) must be re-applied AFTER the objects above are created.
-- This list was derived by diffing the old chain's end-state ACLs against a
-- fresh reset of this baseline; it is exact, not curated.
revoke all on function public.accrue_managed_spend(p_org_id uuid, p_amount_usd numeric, p_provider text, p_model text, p_input_tokens bigint, p_output_tokens bigint, p_input_unit_usd numeric, p_output_unit_usd numeric, p_markup_pct numeric, p_call_kind text, p_eval_run_id uuid, p_opt_run_id uuid) from anon;
revoke all on function public.accrue_managed_spend(p_org_id uuid, p_amount_usd numeric, p_provider text, p_model text, p_input_tokens bigint, p_output_tokens bigint, p_input_unit_usd numeric, p_output_unit_usd numeric, p_markup_pct numeric, p_call_kind text, p_eval_run_id uuid, p_opt_run_id uuid) from authenticated;
revoke all on function public.dashboard_runs(p_org_id uuid, p_window_start timestamp with time zone, p_n integer) from anon;
revoke all on function public.dashboard_runs(p_org_id uuid, p_window_start timestamp with time zone, p_n integer) from authenticated;
revoke all on function public.expire_runs_before(p_org_id uuid, p_cutoff timestamp with time zone) from anon;
revoke all on function public.expire_runs_before(p_org_id uuid, p_cutoff timestamp with time zone) from authenticated;
revoke all on function public.get_provider_secret(p_secret_id uuid) from anon;
revoke all on function public.get_provider_secret(p_secret_id uuid) from authenticated;
revoke all on function public.managed_invoice_candidate_orgs() from anon;
revoke all on function public.managed_invoice_candidate_orgs() from authenticated;
revoke all on function public.managed_spend_total(p_org_id uuid, p_period_start timestamp with time zone) from anon;
revoke all on function public.managed_spend_total(p_org_id uuid, p_period_start timestamp with time zone) from authenticated;
revoke all on function public.managed_uninvoiced_total(p_org_id uuid, p_period_start timestamp with time zone) from anon;
revoke all on function public.managed_uninvoiced_total(p_org_id uuid, p_period_start timestamp with time zone) from authenticated;
revoke all on function public.mark_managed_line_invoiced(p_org_id uuid, p_period_start timestamp with time zone, p_provider text, p_model text, p_amount numeric, p_invoice_id text, p_item_id text) from anon;
revoke all on function public.mark_managed_line_invoiced(p_org_id uuid, p_period_start timestamp with time zone, p_provider text, p_model text, p_amount numeric, p_invoice_id text, p_item_id text) from authenticated;
revoke all on function public.purge_expired_runs(p_grace_days integer) from anon;
revoke all on function public.purge_expired_runs(p_grace_days integer) from authenticated;
revoke all on function public.refresh_managed_invoice_lines(p_org_id uuid, p_period_start timestamp with time zone) from anon;
revoke all on function public.refresh_managed_invoice_lines(p_org_id uuid, p_period_start timestamp with time zone) from authenticated;
revoke all on function public.release_managed_reservation(p_eval_run_id uuid, p_opt_run_id uuid) from anon;
revoke all on function public.release_managed_reservation(p_eval_run_id uuid, p_opt_run_id uuid) from authenticated;
revoke all on function public.reserve_managed_spend(p_org_id uuid, p_estimate_usd numeric, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_cap_usd numeric, p_markup_pct numeric, p_eval_run_id uuid, p_opt_run_id uuid) from anon;
revoke all on function public.reserve_managed_spend(p_org_id uuid, p_estimate_usd numeric, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_cap_usd numeric, p_markup_pct numeric, p_eval_run_id uuid, p_opt_run_id uuid) from authenticated;
revoke all on function public.restore_runs_since(p_org_id uuid, p_cutoff timestamp with time zone) from anon;
revoke all on function public.restore_runs_since(p_org_id uuid, p_cutoff timestamp with time zone) from authenticated;
revoke all on function public.retention_candidate_orgs() from anon;
revoke all on function public.retention_candidate_orgs() from authenticated;
revoke all on function public.set_provider_key(p_org_id uuid, p_provider text, p_secret text, p_last4 text, p_created_by uuid) from anon;
revoke all on function public.set_provider_key(p_org_id uuid, p_provider text, p_secret text, p_last4 text, p_created_by uuid) from authenticated;
revoke all on function public.tick_managed_threshold() from anon;
revoke all on function public.tick_managed_threshold() from authenticated;
revoke all on function public.tick_retention() from anon;
revoke all on function public.tick_retention() from authenticated;
revoke all on table public.billing_notifications from anon;
revoke all on table public.billing_notifications from authenticated;
revoke all on table public.billing_settings from anon;
revoke all on table public.billing_settings from authenticated;
revoke all on table public.managed_invoice_lines from anon;
revoke all on table public.managed_invoice_lines from authenticated;
revoke all on table public.managed_spend_ledger from anon;
revoke all on table public.managed_spend_ledger from authenticated;
revoke all on table public.optimization_run_ledger from anon;
revoke all on table public.optimization_run_ledger from authenticated;
revoke all on table public.overage_invoice_lines from anon;
revoke all on table public.overage_invoice_lines from authenticated;
revoke all on table public.point_ledger from anon;
revoke all on table public.point_ledger from authenticated;

-- Append-only ledgers: service_role keeps read/insert but can never update,
-- delete, or truncate (the point/spend history is immutable by construction).
revoke update, delete, truncate on table public.point_ledger from service_role;
revoke update, delete, truncate on table public.managed_spend_ledger from service_role;
revoke update, delete, truncate on table public.optimization_run_ledger from service_role;
