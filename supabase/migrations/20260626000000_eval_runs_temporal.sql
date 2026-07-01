-- Eval Runs on Temporal (#123, ADR-0006).
--
-- Temporal is the SOLE eval-run execution path (no pgmq executor, no flag). Every run is
-- executed by the durable `runEvalWorkflow`:
--   - interactive runs: createEvalRun stamps workflow_id and starts the workflow directly;
--   - scheduled runs: pg_cron → pgmq → the worker's thin dispatcher stamps workflow_id and
--     starts the workflow, then acks (pg_cron can't call Temporal).
--
-- 1) eval_runs.workflow_id: the stable `eval-<runId>` id, stamped before the workflow starts
--    (mirrors optimization_runs.workflow_id). Null only for a run that has not been dispatched
--    yet (still 'queued').
--
-- 2) reap_stale_eval_runs now skips workflow-driven runs. The reaper exists to recover runs a
--    crashed worker left stuck 'running'; for a Temporal-executed run, retries and resumption
--    are Temporal's job — a long run is *supposed* to stay 'running' past the 10-minute
--    threshold, and reaping it would race a workflow that is still making progress. Since every
--    'running' run is now workflow-driven (workflow_id stamped before the queued→running claim),
--    the reaper is effectively inert — kept as a safety net for a run that somehow reaches
--    'running' with a null workflow_id.
--
-- This redefinition intentionally REBASES the hardened body from
-- 20260612000001_point_ledger_hardening.sql (running-run reap + stuck-'queued' reap +
-- settlement sweep) and adds ONLY the `workflow_id is null` skip guard to the stuck-'running'
-- loop. It is deliberately timestamped AFTER the hardening migration so this definition is the
-- final one on a fresh apply — earlier ordering would let the un-guarded hardening body win and
-- spuriously fail long-running Temporal runs.

alter table public.eval_runs add column if not exists workflow_id text;

create or replace function public.reap_stale_eval_runs(p_threshold_minutes int default 10)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  return v_count;
end;
$$;

revoke execute on function public.reap_stale_eval_runs(int) from public;
grant  execute on function public.reap_stale_eval_runs(int) to service_role;
