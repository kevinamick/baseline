-- Eval runs for the dashboard chart and cards, per org. Returns the union of:
--   * every run inside the caller's window (dense data for the 7/30/90 presets),
--   * each rubric's last p_n runs regardless of age (the Auto range fits these,
--     so a dormant rubric still gets a meaningful chart),
--   * each rubric's last few completed scored runs (its Latest Score, the
--     vs-previous delta, and the focus card's recent-runs list must all survive
--     even when the most recent p_n runs are unscored failures).
-- run_no is the true per-rubric sequence over the rubric's full Run History
-- (oldest = 1), not relative to the fetched window.
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
  )
  select id, rubric_id, status, overall_score, created_at, run_no
  from numbered
  where created_at >= p_window_start
     or rev_no <= p_n
     or (scored and grp_rev_no <= 4) -- last 4 scored runs (focus card shows 4)
  order by created_at;
$$;

-- Lock the function down to the service role. revoke-from-public alone is NOT
-- enough on Supabase: ALTER DEFAULT PRIVILEGES grants EXECUTE on every new
-- public function directly to anon and authenticated at creation time, and
-- those role grants survive a revoke from public — leaving the function
-- callable via PostgREST (/rest/v1/rpc/dashboard_runs) with an attacker-chosen
-- p_org_id. Only supabaseAdmin (service_role) ever calls this.
revoke execute on function public.dashboard_runs(uuid, timestamptz, int) from public, anon, authenticated;
grant  execute on function public.dashboard_runs(uuid, timestamptz, int) to service_role;
