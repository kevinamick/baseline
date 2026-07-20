-- Fix two verified PR #501 code-review findings on the Free-plan lifetime
-- Optimization Run (#181 follow-up, 20260714000000_optimization_lifetime_used.sql).
-- Both bugs are the same root cause from opposite directions: the read side
-- (optimization_lifetime_used, a live sum over the ledger) and the write side
-- (ensure_optimization_grant, a write-once-per-period grant row) can diverge.
--
-- CR-1: ensure_optimization_grant inserts a period's grant row exactly once
-- (on conflict do nothing). A run that reserves its lifetime unit near a
-- period boundary and later settles with zero Rollouts releases that unit
-- back — but the release lands in the RESERVE's period, which may no longer
-- be the current period by settle time. optimization_lifetime_used then
-- recomputes a higher `included` for the NEW period, but that period's grant
-- row is already frozen at the stale (too-low) value it was first written
-- with, and nothing ever tops it up: `included` reads as available forever
-- while `optimization_run_balance` stays stuck at 0. Fix: reconcile_optimization_grant
-- is the run-only half of reconcile_plan_grants (same advisory lock, same
-- 'upgrade'-delta top-up, same "never claws back" idempotence) — the app's
-- allowance read (getOptimizationAllowance) now calls this instead of the
-- plain insert-once ensure_optimization_grant, so a period's grant is topped
-- up to the freshly computed included value on every read, not just its
-- first.
--
-- CR-3: optimization_lifetime_used summed reserve/release across EVERY period
-- the org ever had, on EVERY plan it was ever on. A paid Team that floors to
-- Free (e.g. a declined card) had its own past PAID usage counted against the
-- Free lifetime grant it never received.
--
-- The fix marks a reserve, at the moment it is made, as having consumed a
-- LIFETIME grant: reserve_optimization_run takes p_lifetime and stamps
-- meta->>'lifetime' on the row, settle_optimization_run copies that flag onto
-- the compensating release, and optimization_lifetime_used sums only flagged
-- rows. Attribution is therefore decided once, by the caller that knows the
-- plan, and frozen in an append-only row.
--
-- An earlier revision of this fix inferred the same fact from the row's own
-- period grant total (count the period only when it was granted <= 1, Free's
-- lifetime count). That reading is derived from MUTABLE state: a mid-period
-- upgrade makes reconcile_plan_grants top the period up to the new plan's
-- count (15/75), so a Free Team that spent its lifetime run, upgraded, then
-- floored back to Free would have its spent period silently reclassified as
-- paid and be handed a second lifetime run. It also hard-coded Free's
-- includedOptimizationRuns as a SQL literal, which a second lifetime plan (or
-- any per-period plan with a count of 1) would break. The explicit flag has
-- neither problem.
--
-- No backfill: no reserve has ever been made against a lifetime grant (Free
-- gains its lifetime run in this same PR), so every pre-existing row is
-- correctly unflagged and correctly ignored. Fixtures that fabricate a spent
-- lifetime unit must set meta.lifetime themselves (scripts/seed-e2e.mjs,
-- e2e/free-lifetime-optimization.spec.ts).

CREATE OR REPLACE FUNCTION "public"."reconcile_optimization_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included_runs" bigint) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_granted bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 1));

  perform ensure_optimization_grant(p_org_id, p_period_start, p_period_end, p_included_runs);

  select coalesce(sum(units), 0) into v_granted
  from optimization_run_ledger
  where org_id = p_org_id
    and period_start = p_period_start
    and entry_type in ('grant', 'upgrade');

  if p_included_runs > v_granted then
    insert into optimization_run_ledger (org_id, entry_type, units, period_start, period_end, meta)
    values (p_org_id, 'upgrade', p_included_runs - v_granted, p_period_start, p_period_end,
            jsonb_build_object('included', p_included_runs, 'reason', 'lifetime_reconcile'));
  end if;
end;
$$;

ALTER FUNCTION "public"."reconcile_optimization_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included_runs" bigint) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."reconcile_optimization_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included_runs" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reconcile_optimization_grant"("p_org_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included_runs" bigint) TO "service_role";

revoke all on function public.reconcile_optimization_grant(p_org_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_included_runs bigint) from anon;
revoke all on function public.reconcile_optimization_grant(p_org_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_included_runs bigint) from authenticated;

-- reserve_optimization_run gains p_lifetime. A DEFAULT would make the 5-arg
-- call ambiguous against the existing overload, so the old signature is
-- dropped outright; it has no SQL-internal callers (only the app's allowance
-- module and tests call it).
DROP FUNCTION IF EXISTS "public"."reserve_optimization_run"("uuid", "uuid", timestamp with time zone, timestamp with time zone, bigint);

CREATE OR REPLACE FUNCTION "public"."reserve_optimization_run"("p_org_id" "uuid", "p_run_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint, "p_lifetime" boolean DEFAULT false) RETURNS TABLE("reserved" boolean, "balance" bigint)
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

  -- p_lifetime is the caller's assertion that this unit comes out of a
  -- lifetime grant (PLANS[plan].optimizationRunsGrant = 'lifetime'). It is
  -- frozen here and read back by optimization_lifetime_used; nothing
  -- downstream may reinterpret it.
  insert into optimization_run_ledger (org_id, entry_type, units, opt_run_id, period_start, period_end, meta)
  values (p_org_id, 'reserve', 1, p_run_id, p_period_start, p_period_end,
          case when p_lifetime then jsonb_build_object('lifetime', true) else '{}'::jsonb end);

  return query select true, v_balance - 1;
end;
$$;

ALTER FUNCTION "public"."reserve_optimization_run"("p_org_id" "uuid", "p_run_id" "uuid", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone, "p_included" bigint, "p_lifetime" boolean) OWNER TO "postgres";

-- Grants restored to match the dropped function's ACL exactly (the schema
-- baseline grants this one to anon/authenticated as well as service_role).
REVOKE ALL ON FUNCTION "public"."reserve_optimization_run"("p_org_id" "uuid", "p_run_id" "uuid", timestamp with time zone, timestamp with time zone, bigint, boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reserve_optimization_run"("p_org_id" "uuid", "p_run_id" "uuid", timestamp with time zone, timestamp with time zone, bigint, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."reserve_optimization_run"("p_org_id" "uuid", "p_run_id" "uuid", timestamp with time zone, timestamp with time zone, bigint, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."reserve_optimization_run"("p_org_id" "uuid", "p_run_id" "uuid", timestamp with time zone, timestamp with time zone, bigint, boolean) TO "service_role";

-- settle_optimization_run: unchanged except that the compensating release
-- carries the reserve's lifetime flag, so a released unit nets back out of
-- optimization_lifetime_used without that sum needing to join reserve to
-- release (fixture rows may carry no opt_run_id to join on).
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
    insert into optimization_run_ledger (org_id, entry_type, units, opt_run_id, period_start, period_end, meta)
    values (r.org_id, 'release', 1, p_run_id, r.period_start, r.period_end,
            case when coalesce(r.meta->>'lifetime', 'false') = 'true'
                 then jsonb_build_object('lifetime', true)
                 else '{}'::jsonb end)
    on conflict (opt_run_id) where (entry_type = 'release') do nothing;
  end if;

  -- Overage projection (#183).
  perform refresh_overage_line(r.org_id, r.period_start, 'runs');
end;
$$;

ALTER FUNCTION "public"."settle_optimization_run"("p_run_id" "uuid") OWNER TO "postgres";

-- Net lifetime units consumed: only rows explicitly stamped as lifetime
-- consumption count, so no plan transition, grant top-up, or per-period plan
-- count can reclassify history.
CREATE OR REPLACE FUNCTION "public"."optimization_lifetime_used"("p_org_id" "uuid") RETURNS bigint
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(sum(
    case l.entry_type when 'reserve' then l.units when 'release' then -l.units else 0 end
  ), 0)
  from optimization_run_ledger l
  where l.org_id = p_org_id
    and l.entry_type in ('reserve', 'release')
    and coalesce(l.meta->>'lifetime', 'false') = 'true';
$$;
