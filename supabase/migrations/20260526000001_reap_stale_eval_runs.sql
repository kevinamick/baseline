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
  v_run record;
  v_count int := 0;
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

    -- Remove the bouncing pgmq message so it stops redelivering.
    delete from pgmq.q_eval_runs
    where (message->>'runId')::uuid = v_run.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.reap_stale_eval_runs(int) from public;
grant  execute on function public.reap_stale_eval_runs(int) to service_role;
