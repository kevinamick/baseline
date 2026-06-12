-- Point Ledger hardening (#180 review follow-ups).
--
-- 1. The stale-run reaper learns about reservations: reaped runs (and any
--    crash-stranded states) settle through a general sweep — every run in a
--    terminal status still holding an open reservation gets settled by its
--    status. This single sweep closes every crash window at once: a worker
--    killed between the status update and its settle call, a reaped run, a
--    server action killed after reserving.
-- 2. Runs stuck in 'queued' with no queue message (enqueue failed after the
--    reservation committed, or the action process died mid-create) are reaped
--    too — they can never execute, and their reservation would otherwise pin
--    points until the period rolls over.
-- 3. billing_notifications: at-most-once-per-period delivery ledger for limit
--    emails, so a user retrying a refused run doesn't spam every Contributor.

create table public.billing_notifications (
  org_id       uuid not null references public.organizations(id) on delete cascade,
  kind         text not null,
  period_start timestamptz not null,
  sent_at      timestamptz not null default now(),
  primary key (org_id, kind, period_start)
);

alter table public.billing_notifications enable row level security;
revoke all on public.billing_notifications from public, anon, authenticated;

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
  -- Stuck 'running' runs: worker died or stalled mid-evaluation.
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

  -- Stuck 'queued' runs with no message to ever dequeue: the create flow died
  -- between reserving and enqueueing. They will never run; fail them so the
  -- settlement sweep below releases their points.
  update public.eval_runs er
  set status        = 'failed',
      error_message = 'Never reached the queue',
      updated_at    = now()
  where er.status = 'queued'
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

-- Keep the queued-run scan cheap alongside the existing running-run index.
create index if not exists eval_runs_queued_updated_idx
  on public.eval_runs(updated_at)
  where status = 'queued';

revoke execute on function public.reap_stale_eval_runs(int) from public;
grant  execute on function public.reap_stale_eval_runs(int) to service_role;
