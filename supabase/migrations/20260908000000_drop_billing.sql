-- Billing is gone (ADR-0020): no Stripe, no Plans, no Eval Points, no managed key, no
-- retention windows, no trust tiers. This drops every table, function, and cron job that
-- only existed to meter, cap, invoice, or age out a Team's usage, and rewrites the two run
-- reapers without their settlement sweeps. The remaining schema is the product: rubrics,
-- runs, results, connections, schedules, optimization runs, provider keys, worker config.

-- ---------------------------------------------------------------------------
-- 1. Cron jobs that drove billing + retention.
-- ---------------------------------------------------------------------------
select cron.unschedule(jobid)
  from cron.job
 where jobname in ('tick-managed-threshold', 'tick-retention', 'purge-expired-runs');

-- ---------------------------------------------------------------------------
-- 2. Functions (drop before tables so nothing still references them).
-- ---------------------------------------------------------------------------
drop function if exists public.tick_managed_threshold();
drop function if exists public.tick_retention();
drop function if exists public.purge_expired_runs(integer);
drop function if exists public.retention_candidate_orgs();
drop function if exists public.expire_runs_before(uuid, timestamptz);
drop function if exists public.restore_runs_since(uuid, timestamptz);
drop function if exists public.managed_invoice_candidate_orgs();
drop function if exists public.refresh_managed_invoice_lines(uuid, timestamptz);
drop function if exists public.refresh_overage_line(uuid, timestamptz, text);
drop function if exists public.mark_managed_line_invoiced(uuid, timestamptz, text, text, numeric, text, text);
drop function if exists public.managed_uninvoiced_total(uuid, timestamptz);
drop function if exists public.managed_spend_total(uuid, timestamptz);
drop function if exists public.managed_spend_reserved_total(uuid, timestamptz);
drop function if exists public.accrue_managed_spend(uuid, numeric, text, text, bigint, bigint, numeric, numeric, numeric, text, uuid, uuid);
drop function if exists public.reserve_managed_spend(uuid, numeric, timestamptz, timestamptz, numeric, numeric, uuid, uuid);
drop function if exists public.release_managed_reservation(uuid, uuid);
drop function if exists public.projected_overage_usd(bigint, numeric);
drop function if exists public.settle_eval_run_points(uuid, text);
drop function if exists public.settle_optimization_run_points(uuid, text);
drop function if exists public.settle_optimization_run(uuid);
drop function if exists public.reserve_eval_points(uuid, uuid, bigint, timestamptz, timestamptz, bigint, jsonb, numeric);
drop function if exists public.reserve_optimization_points(uuid, uuid, bigint, timestamptz, timestamptz, bigint, jsonb, numeric);
drop function if exists public.reserve_optimization_run(uuid, uuid, timestamptz, timestamptz, bigint);
drop function if exists public.reserve_optimization_run(uuid, uuid, timestamptz, timestamptz, bigint, boolean);
drop function if exists public.reconcile_plan_grants(uuid, timestamptz, timestamptz, bigint, bigint);
drop function if exists public.reconcile_optimization_grant(uuid, timestamptz, timestamptz, bigint);
drop function if exists public.ensure_point_grant(uuid, timestamptz, timestamptz, bigint);
drop function if exists public.ensure_optimization_grant(uuid, timestamptz, timestamptz, bigint);
drop function if exists public.optimization_run_balance(uuid, timestamptz);
drop function if exists public.optimization_lifetime_used(uuid);
drop function if exists public.point_balance(uuid, timestamptz);

-- ---------------------------------------------------------------------------
-- 3. Tables.
-- ---------------------------------------------------------------------------
drop table if exists public.managed_invoice_lines;
drop table if exists public.overage_invoice_lines;
drop table if exists public.paid_invoices;
drop table if exists public.managed_spend_ledger;
drop table if exists public.optimization_run_ledger;
drop table if exists public.point_ledger;
drop table if exists public.billing_notifications;
drop table if exists public.billing_settings;
drop table if exists public.billing_events;
drop table if exists public.customers;

alter table public.worker_config
  drop column if exists managed_threshold_url,
  drop column if exists managed_threshold_secret,
  drop column if exists retention_url,
  drop column if exists retention_secret;

-- ---------------------------------------------------------------------------
-- 4. The reapers, minus their settlement sweeps.
-- ---------------------------------------------------------------------------
create or replace function public.reap_stale_eval_runs(p_threshold_minutes integer default 10)
returns integer
language plpgsql security definer
set search_path to 'public', 'pg_temp'
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

    if v_affected > 0 then
      delete from pgmq.q_eval_runs
      where (message->>'runId')::uuid = v_run.id;
      v_count := v_count + 1;
    end if;
  end loop;

  -- Stuck 'queued' runs with no message to ever dequeue and no workflow: the create flow died
  -- between inserting and starting. They will never run; fail them.
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

  return v_count;
end;
$$;

create or replace function public.reap_stale_optimization_runs(p_threshold_minutes integer default 30)
returns integer
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_count int;
begin
  with reaped as (
    update public.optimization_runs
    set status        = 'failed',
        error_message = 'Run timed out — no progress within the staleness window',
        updated_at    = now()
    where status = 'running'
      and updated_at < now() - (p_threshold_minutes || ' minutes')::interval
    returning 1
  )
  select count(*) into v_count from reaped;

  with reaped_queued as (
    update public.optimization_runs
    set status        = 'failed',
        error_message = 'Never started',
        updated_at    = now()
    where status = 'queued'
      and workflow_id is null
      and updated_at < now() - (p_threshold_minutes || ' minutes')::interval
    returning 1
  )
  select v_count + count(*) into v_count from reaped_queued;

  return v_count;
end;
$$;
