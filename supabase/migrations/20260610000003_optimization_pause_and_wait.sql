-- Pause-and-wait on endpoint outage (#102), part 2 of 2. When the circuit breaker (#90)
-- trips, the Temporal workflow now PAUSES in place (status 'paused') and waits for the
-- endpoint to recover — auto-probing on a backoff schedule, resumable immediately via a
-- "retry now" signal — instead of failing terminally. A max-wait cap backstops a
-- permanently-dead endpoint by failing the run as before.

-- A paused run is still "active": it deliberately keeps holding the org's one-active-run
-- slot (a second concurrent start stays rejected) so an in-flight optimization survives an
-- outage rather than losing its progress. Recreate the partial unique index to cover it.
drop index if exists public.optimization_runs_one_active_per_org;
create unique index optimization_runs_one_active_per_org
  on public.optimization_runs(org_id)
  where status in ('queued', 'running', 'paused');

alter table public.optimization_runs
  -- Human-readable "why is this run paused" for getOptimizationRun() ("waiting for your
  -- endpoint to recover"). Set on pause, cleared on resume; distinct from error_message,
  -- which stays reserved for terminal failures.
  add column paused_reason text,
  -- Max total time a run may sit paused before it gives up and fails (the backstop for a
  -- permanently-dead endpoint). Default ~24h.
  add column pause_max_wait_minutes int not null default 1440
    constraint optimization_runs_pause_max_wait_positive check (pause_max_wait_minutes > 0),
  -- Initial delay before the first health probe while paused; the workflow backs off
  -- (doubling, capped in code) from here between failed probes.
  add column probe_interval_seconds int not null default 60
    constraint optimization_runs_probe_interval_positive check (probe_interval_seconds > 0);

-- NOTE: the stale-run reaper (reap_stale_optimization_runs, 20260609000000) intentionally
-- stays scoped to status = 'running'. A paused run is quiescent by design (nothing
-- heartbeats it while it waits), so reaping it would defeat the pause — its own max-wait
-- cap is the backstop instead.
