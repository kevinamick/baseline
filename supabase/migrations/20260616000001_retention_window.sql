-- Retention Window — soft-delete at the window, purge 30 days later (#187, ADR-0008).
--
-- Runs older than the Plan's Retention Window (Free 14d / Builder 90d / Scale 3y)
-- are SOFT-deleted (deleted_at stamped) and vanish from the product; a scheduled
-- job PERMANENTLY purges rows 30 days after soft-deletion. Two invariants bind the
-- design (ADR-0008, final form):
--   1. Billing state changes never destroy data instantly — permanent deletion
--      happens ONLY by the purge job, always >=30 days after the data left
--      visibility, never as a synchronous side effect of a plan change or payment
--      failure. (A downgrade cliff soft-deletes + emails; it never hard-deletes.)
--   2. The window is a CODE constant (PLANS[plan].retentionDays), env-mapped from
--      the Stripe price — so, like threshold billing (#186), the SQL stays "dumb":
--      it acts on an app-supplied cutoff, never resolving a plan itself. The aging
--      sweep is therefore app-driven (tick_retention pokes a route that knows the
--      constants); only the grace-period purge, which needs no plan knowledge, is
--      pure SQL on its own cron.
--
-- eval_runs / optimization_runs are mutable (the worker UPDATEs status), so a
-- deleted_at stamp is the right mechanism — unlike the append-only ledgers, which
-- have service_role write revoked. The RPCs are SECURITY DEFINER (owner-privileged)
-- so the soft-delete UPDATE and purge DELETE run regardless of service_role grants;
-- callers only need EXECUTE. Children cascade on the purge DELETE (every child FK
-- is ON DELETE CASCADE).

-- ---------------------------------------------------------------------------
-- Soft-delete state. A null deleted_at = live (in-window); a non-null stamp =
-- hidden everywhere and counting down to purge.
alter table public.eval_runs        add column deleted_at timestamptz;
alter table public.optimization_runs add column deleted_at timestamptz;

-- Purge scans by "soft-deleted long enough ago"; a partial index keeps that scan
-- off the (overwhelmingly null) live rows.
create index eval_runs_deleted_at_idx
  on public.eval_runs (deleted_at) where deleted_at is not null;
create index optimization_runs_deleted_at_idx
  on public.optimization_runs (deleted_at) where deleted_at is not null;

-- ---------------------------------------------------------------------------
-- App-driven aging config (mirrors managed_threshold_url/secret, #186): the cron
-- pokes this route, which resolves each org's plan-coded window and drives the
-- soft-delete. Singleton worker_config row (id = 1); seeded out-of-git in ops.
alter table public.worker_config add column if not exists retention_url    text;
alter table public.worker_config add column if not exists retention_secret text;

-- ---------------------------------------------------------------------------
-- Soft-delete every live run created before p_cutoff for one org. Eval runs scope
-- through their rubric (no direct org_id); optimization runs carry org_id. Active
-- runs (queued/running) are NEVER expired — retention only touches settled history,
-- and an in-flight run can't be out of window anyway (the reaper fails stuck ones
-- long before any plan's window). Idempotent: an already-stamped row is skipped, so
-- a re-run (cron overlap, webhook retry) returns 0 and never re-stamps. Returns the
-- count newly hidden, so the downgrade-cliff caller can report it to Contributors.
create or replace function public.expire_runs_before(
  p_org_id uuid,
  p_cutoff timestamptz
)
returns table (eval_expired integer, opt_expired integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

-- ---------------------------------------------------------------------------
-- Re-upgrade recovery (#187, ADR-0008): clear the soft-delete flag for runs that
-- are back inside the (now larger) window. Only un-purged rows can be restored —
-- purged rows are physically gone, so this naturally restores "everything not yet
-- purged" without a grace check. Symmetric with expire_runs_before's cutoff.
create or replace function public.restore_runs_since(
  p_org_id uuid,
  p_cutoff timestamptz
)
returns table (eval_restored integer, opt_restored integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

-- ---------------------------------------------------------------------------
-- The purge. Permanently delete rows soft-deleted at least p_grace_days ago
-- (default 30). The two predicates are the safety invariant, verified by
-- adversarial fixtures: deleted_at IS NOT NULL excludes every live/in-window row,
-- and the age bound excludes anything within the grace window — so the purge can
-- NEVER touch in-window or recently-soft-deleted data. Children cascade. Global
-- (plan-agnostic), so it runs as a pure-SQL cron with no app round-trip.
create or replace function public.purge_expired_runs(p_grace_days integer default 30)
returns table (eval_purged integer, opt_purged integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

-- ---------------------------------------------------------------------------
-- Orgs that hold any live run — the aging sweep's candidate set. The route
-- resolves each one's plan-coded window and calls expire_runs_before. Distinct
-- union across both meters; eval runs reach their org through the rubric. A
-- SETOF function (not a REST table read) so the candidate list can't be truncated
-- at PostgREST's row cap.
create or replace function public.retention_candidate_orgs()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select rb.org_id
    from public.eval_runs er
    join public.rubrics rb on rb.id = er.rubric_id
   where er.deleted_at is null
  union
  select o.org_id
    from public.optimization_runs o
   where o.deleted_at is null;
$$;

-- ---------------------------------------------------------------------------
-- The aging sweep tick. Pokes the app route (which owns the plan-coded window)
-- when any Team holds live runs. Mirrors tick_managed_threshold (#186): net.http_post
-- to a configured URL with a bearer secret, only when there is work. Returns the
-- candidate count.
create or replace function public.tick_retention()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp, net
as $$
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

-- ---------------------------------------------------------------------------
-- Service-role only (the server + cron run as service_role; the DEFINER body does
-- the privileged work, callers just need EXECUTE).
revoke execute on function public.expire_runs_before(uuid, timestamptz)  from public, anon, authenticated;
revoke execute on function public.restore_runs_since(uuid, timestamptz)  from public, anon, authenticated;
revoke execute on function public.purge_expired_runs(integer)            from public, anon, authenticated;
revoke execute on function public.retention_candidate_orgs()             from public, anon, authenticated;
revoke execute on function public.tick_retention()                       from public, anon, authenticated;
grant  execute on function public.expire_runs_before(uuid, timestamptz)  to service_role;
grant  execute on function public.restore_runs_since(uuid, timestamptz)  to service_role;
grant  execute on function public.purge_expired_runs(integer)            to service_role;
grant  execute on function public.retention_candidate_orgs()             to service_role;
grant  execute on function public.tick_retention()                       to service_role;

-- ---------------------------------------------------------------------------
-- The dashboard chart/cards must also hide soft-deleted runs (#187) — it's a read
-- surface like every server action. Re-stated verbatim from
-- 20260610000000_dashboard_runs_rpc.sql with the deleted_at filter added; the
-- grants below restore the service-role lockdown create-or-replace leaves intact.
create or replace function public.dashboard_runs(
  p_org_id uuid,
  p_window_start timestamptz,
  p_n int default 10
)
returns table (
  id            uuid,
  rubric_id     uuid,
  status        public.eval_run_status,
  overall_score numeric,
  created_at    timestamptz,
  run_no        bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
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

revoke execute on function public.dashboard_runs(uuid, timestamptz, int) from public, anon, authenticated;
grant  execute on function public.dashboard_runs(uuid, timestamptz, int) to service_role;

-- ---------------------------------------------------------------------------
-- Cron registration (idempotent across db resets).
--   * aging sweep — daily; the window is day-granular (14/90/1095 days), so a
--     daily soft-delete is timely. Pokes the route only when there is work.
--   * purge — daily, pure SQL; no plan knowledge, runs even if the app is down.
do $$
begin
  perform cron.unschedule('tick-retention');
exception when others then
  null;
end
$$;
do $$
begin
  perform cron.unschedule('purge-expired-runs');
exception when others then
  null;
end
$$;

select cron.schedule('tick-retention',      '23 2 * * *', $$ select public.tick_retention(); $$);
select cron.schedule('purge-expired-runs',  '47 3 * * *', $$ select public.purge_expired_runs(); $$);
