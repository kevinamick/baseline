-- Reaps eval_runs stuck in 'running' beyond the threshold and acks the
-- corresponding pgmq message so it stops bouncing in the queue.
-- Returns the number of runs reaped.
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

-- Partial index so the stale-run scan stays fast as eval_runs grows.
create index if not exists eval_runs_running_updated_idx
  on public.eval_runs(updated_at)
  where status = 'running';

revoke execute on function public.reap_stale_eval_runs(int) from public;
grant  execute on function public.reap_stale_eval_runs(int) to service_role;
