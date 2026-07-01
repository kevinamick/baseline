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
  for v_run in
    select id
    from public.eval_runs
    where status = 'running'
      and workflow_id is null  -- Temporal owns retries/resumption for workflow-driven runs
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

  return v_count;
end;
$$;
