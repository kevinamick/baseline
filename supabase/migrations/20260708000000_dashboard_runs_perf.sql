-- dashboard_runs perf rework + SQL-side criterion averages (#177, item 1).
--
-- The baseline definition computed three row_number() windows over EVERY
-- eval_run for the org on each dashboard render, then discarded most rows in
-- the outer WHERE — the window functions need the full partition, so
-- eval_runs_rubric_idx (rubric_id, created_at desc) could order the scan but
-- not prune it, and TTFB degraded linearly with total run history.
--
-- This rework keeps the output contract byte-identical:
--   * rows: (90d window) ∪ (per-rubric last p_n runs) ∪ (per-rubric last 4
--     scored runs), deduped, ascending created_at;
--   * run_no: the run's 1-based per-rubric ordinal by created_at, counted over
--     the rubric's whole non-deleted history (not just returned rows);
--   * deleted_at is null everywhere (returned rows AND the run_no count);
--   * org scoping via the rubrics join; SECURITY DEFINER + service_role-only,
--     same as the baseline definition.
-- ...but each UNION branch is an index-served scan (the range scan and the two
-- per-rubric LATERAL top-ups all walk eval_runs_rubric_idx), and run_no is a
-- correlated count computed only for the handful of returned rows.
--
-- Tie note: rows sharing a created_at within one rubric get the same run_no
-- (count of runs at-or-before) where row_number() would have split them
-- arbitrarily. created_at defaults to now() so ties are effectively absent;
-- when they do occur this is at least deterministic.

create or replace function public.dashboard_runs(
  p_org_id uuid,
  p_window_start timestamp with time zone,
  p_n integer default 10
) returns table (
  id uuid,
  rubric_id uuid,
  status public.eval_run_status,
  overall_score numeric,
  created_at timestamp with time zone,
  run_no bigint
)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  with org_rubrics as (
    select rb.id
    from public.rubrics rb
    where rb.org_id = p_org_id
  ),
  picked as (
    -- Runs inside the window: per-rubric range scan on (rubric_id, created_at).
    select r.id, r.rubric_id, r.status, r.overall_score, r.created_at
    from org_rubrics rb
    join public.eval_runs r on r.rubric_id = rb.id
    where r.deleted_at is null
      and r.created_at >= p_window_start
    union
    -- Each rubric's last p_n runs, any status/age (Auto-range top-up).
    select l.id, l.rubric_id, l.status, l.overall_score, l.created_at
    from org_rubrics rb
    cross join lateral (
      select r.id, r.rubric_id, r.status, r.overall_score, r.created_at
      from public.eval_runs r
      where r.rubric_id = rb.id
        and r.deleted_at is null
      order by r.created_at desc
      limit p_n
    ) l
    union
    -- Each rubric's last 4 scored runs, however old (focus card shows 4).
    select s.id, s.rubric_id, s.status, s.overall_score, s.created_at
    from org_rubrics rb
    cross join lateral (
      select r.id, r.rubric_id, r.status, r.overall_score, r.created_at
      from public.eval_runs r
      where r.rubric_id = rb.id
        and r.deleted_at is null
        and r.status = 'completed'
        and r.overall_score is not null
      order by r.created_at desc
      limit 4
    ) s
  )
  select
    p.id, p.rubric_id, p.status, p.overall_score, p.created_at,
    (
      select count(*)
      from public.eval_runs r2
      where r2.rubric_id = p.rubric_id
        and r2.deleted_at is null
        and r2.created_at <= p.created_at
    ) as run_no
  from picked p
  order by p.created_at;
$$;

alter function public.dashboard_runs(p_org_id uuid, p_window_start timestamp with time zone, p_n integer) owner to postgres;

-- create or replace preserves the existing ACL, but re-assert the baseline's
-- posture explicitly so this file stands on its own: service_role only.
revoke all on function public.dashboard_runs(p_org_id uuid, p_window_start timestamp with time zone, p_n integer) from public;
revoke all on function public.dashboard_runs(p_org_id uuid, p_window_start timestamp with time zone, p_n integer) from anon;
revoke all on function public.dashboard_runs(p_org_id uuid, p_window_start timestamp with time zone, p_n integer) from authenticated;
grant all on function public.dashboard_runs(p_org_id uuid, p_window_start timestamp with time zone, p_n integer) to service_role;


-- Per-criterion score averages for a set of runs, aggregated in SQL so the
-- dashboard transfers one row per (run, criterion) instead of rows × criteria
-- (the page previously pulled every eval_run_results row and averaged in JS).
-- Org-scoped through the eval_runs → rubrics join even though the caller only
-- passes ids it got from dashboard_runs — same belt-and-suspenders as the rest
-- of the service-role surface.

create or replace function public.dashboard_run_criteria(
  p_org_id uuid,
  p_run_ids uuid[]
) returns table (
  eval_run_id uuid,
  criterion_name text,
  avg_score numeric
)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select rr.eval_run_id, rr.criterion_name, avg(rr.score) as avg_score
  from public.eval_run_results rr
  join public.eval_runs r on r.id = rr.eval_run_id
  join public.rubrics rb on rb.id = r.rubric_id
  where rr.eval_run_id = any (p_run_ids)
    and rb.org_id = p_org_id
  group by rr.eval_run_id, rr.criterion_name;
$$;

alter function public.dashboard_run_criteria(p_org_id uuid, p_run_ids uuid[]) owner to postgres;

-- Supabase's default privileges auto-grant anon/authenticated on new
-- functions; strip them (see the baseline's security-hardening block).
revoke all on function public.dashboard_run_criteria(p_org_id uuid, p_run_ids uuid[]) from public;
revoke all on function public.dashboard_run_criteria(p_org_id uuid, p_run_ids uuid[]) from anon;
revoke all on function public.dashboard_run_criteria(p_org_id uuid, p_run_ids uuid[]) from authenticated;
grant all on function public.dashboard_run_criteria(p_org_id uuid, p_run_ids uuid[]) to service_role;
