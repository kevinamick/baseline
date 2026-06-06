-- Stale-run reaper for Optimization Runs (#90), mirroring reap_stale_eval_runs (20260526000001).
-- A crashed/evicted/terminated worker can leave a run stuck 'queued'/'running'. Because the
-- one-active-per-org partial unique index (20260607000000) covers both, such a run would block
-- every future run for that org with no in-app recovery. This marks runs left active past a
-- staleness threshold 'failed', freeing the org's slot.
--
-- No queue cleanup (unlike the eval reaper): Optimization Runs are driven by a Temporal workflow,
-- not pgmq. The Activities heartbeat updated_at (touchOptimizationRun) so a legitimately long run
-- stays fresh; only a genuinely stranded run goes stale. The threshold must exceed a single
-- rollout Activity's startToCloseTimeout (20 min) so an in-flight rollout is never reaped.
create or replace function public.reap_stale_optimization_runs(p_threshold_minutes int default 30)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  with reaped as (
    update public.optimization_runs
    set status        = 'failed',
        error_message = 'Run timed out — no progress within the staleness window',
        updated_at    = now()
    where status in ('queued', 'running')
      and updated_at < now() - (p_threshold_minutes || ' minutes')::interval
    returning 1
  )
  select count(*) into v_count from reaped;

  return v_count;
end;
$$;

-- Partial index so the stale-run scan stays fast as optimization_runs grows.
create index if not exists optimization_runs_active_updated_idx
  on public.optimization_runs(updated_at)
  where status in ('queued', 'running');

revoke execute on function public.reap_stale_optimization_runs(int) from public;
grant  execute on function public.reap_stale_optimization_runs(int) to service_role;
