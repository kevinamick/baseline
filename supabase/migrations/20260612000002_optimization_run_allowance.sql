-- Optimization Run allowance (#181, ADR-0008): the second consumable meter, on
-- the same reserve/settle ledger semantics as Eval Points but as its own pool —
-- Optimization Runs never consume Eval Points. Unit-denominated: one run
-- reserves one unit of the Team's per-period allowance.
--
--   grant    +units   the period's included run count (one per org per period)
--   reserve  -units   one unit, taken atomically at run creation
--   settle    0/1     closes a reservation; units = 1 when the run did real work
--   release  +units   returns the unit when the run failed before any Rollout
--
-- Unlike the points settle, the outcome is DERIVED, not passed: a run that
-- executed at least one Rollout consumed its unit; one that never got that far
-- releases it (#181: "failed-before-work runs release their reservation").

create table public.optimization_run_ledger (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  entry_type   text not null check (entry_type in ('grant', 'reserve', 'settle', 'release')),
  units        bigint not null check (units >= 0),
  opt_run_id   uuid references public.optimization_runs(id) on delete set null,
  period_start timestamptz not null,
  period_end   timestamptz not null,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create unique index optimization_run_ledger_one_grant_per_period
  on public.optimization_run_ledger (org_id, period_start)
  where (entry_type = 'grant');
create unique index optimization_run_ledger_one_reserve_per_run
  on public.optimization_run_ledger (opt_run_id)
  where (entry_type = 'reserve');
create unique index optimization_run_ledger_one_settle_per_run
  on public.optimization_run_ledger (opt_run_id)
  where (entry_type = 'settle');
create unique index optimization_run_ledger_one_release_per_run
  on public.optimization_run_ledger (opt_run_id)
  where (entry_type = 'release');
create index optimization_run_ledger_org_period_idx
  on public.optimization_run_ledger (org_id, period_start, created_at desc);

alter table public.optimization_run_ledger enable row level security;

-- Append-only, same contract as point_ledger: corrections are new entries.
revoke all on public.optimization_run_ledger from public, anon, authenticated;
revoke update, delete, truncate on public.optimization_run_ledger from service_role;

-- ---------------------------------------------------------------------------
create or replace function public.ensure_optimization_grant(
  p_org_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_included bigint
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into optimization_run_ledger (org_id, entry_type, units, period_start, period_end)
  values (p_org_id, 'grant', p_included, p_period_start, p_period_end)
  on conflict (org_id, period_start) where (entry_type = 'grant') do nothing;
$$;

create or replace function public.optimization_run_balance(
  p_org_id uuid,
  p_period_start timestamptz
) returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    sum(
      case entry_type
        when 'grant'   then units
        when 'release' then units
        when 'reserve' then -units
        else 0
      end
    ),
    0
  )
  from optimization_run_ledger
  where org_id = p_org_id
    and period_start = p_period_start;
$$;

-- Atomic one-unit reserve under a per-org advisory lock (key space 1; the
-- points ledger uses 0 — the two meters never contend with each other).
create or replace function public.reserve_optimization_run(
  p_org_id uuid,
  p_run_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_included bigint
) returns table (reserved boolean, balance bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 1));
  perform ensure_optimization_grant(p_org_id, p_period_start, p_period_end, p_included);

  v_balance := optimization_run_balance(p_org_id, p_period_start);
  if v_balance < 1 then
    return query select false, v_balance;
    return;
  end if;

  insert into optimization_run_ledger (org_id, entry_type, units, opt_run_id, period_start, period_end)
  values (p_org_id, 'reserve', 1, p_run_id, p_period_start, p_period_end);

  return query select true, v_balance - 1;
end;
$$;

-- Settle at terminal state. The outcome is derived: any executed Rollout means
-- the run did real work and the unit is consumed; otherwise it's released.
-- Idempotent (partial unique indexes + the settled guard) and a no-op for
-- unmetered runs.
create or replace function public.settle_optimization_run(
  p_run_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_worked boolean;
begin
  select * into r
  from optimization_run_ledger
  where opt_run_id = p_run_id and entry_type = 'reserve';
  if not found then
    return;
  end if;

  if exists (
    select 1 from optimization_run_ledger
    where opt_run_id = p_run_id and entry_type = 'settle'
  ) then
    return;
  end if;

  select exists (
    select 1
    from optimization_rollouts ro
    join optimization_candidates c on c.id = ro.candidate_id
    where c.opt_run_id = p_run_id
  ) into v_worked;

  insert into optimization_run_ledger (org_id, entry_type, units, opt_run_id, period_start, period_end, meta)
  values (r.org_id, 'settle', case when v_worked then 1 else 0 end, p_run_id,
          r.period_start, r.period_end, jsonb_build_object('worked', v_worked))
  on conflict (opt_run_id) where (entry_type = 'settle') do nothing;

  if not v_worked then
    insert into optimization_run_ledger (org_id, entry_type, units, opt_run_id, period_start, period_end)
    values (r.org_id, 'release', 1, p_run_id, r.period_start, r.period_end)
    on conflict (opt_run_id) where (entry_type = 'release') do nothing;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The optimization reaper learns about reservations, mirroring the eval reaper:
-- reap stuck 'running' runs, fail crash-stranded 'queued' runs that never got a
-- workflow, then sweep-settle every terminal run still holding a reservation.
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
    where status = 'running'
      and updated_at < now() - (p_threshold_minutes || ' minutes')::interval
    returning 1
  )
  select count(*) into v_count from reaped;

  -- A 'queued' run with no workflow id: the create flow died between the
  -- insert and the Temporal start. It will never run; fail it so the sweep
  -- below releases its unit (and the org's single active slot frees).
  update public.optimization_runs
  set status        = 'failed',
      error_message = 'Never started',
      updated_at    = now()
  where status = 'queued'
    and workflow_id is null
    and updated_at < now() - (p_threshold_minutes || ' minutes')::interval;

  -- Settlement sweep: idempotent, closes every crash window.
  perform public.settle_optimization_run(r.opt_run_id)
  from public.optimization_run_ledger r
  join public.optimization_runs o on o.id = r.opt_run_id
  where r.entry_type = 'reserve'
    and o.status in ('completed', 'failed')
    and not exists (
      select 1 from public.optimization_run_ledger s
      where s.opt_run_id = r.opt_run_id and s.entry_type = 'settle'
    );

  return v_count;
end;
$$;

revoke execute on function public.ensure_optimization_grant(uuid, timestamptz, timestamptz, bigint) from public;
revoke execute on function public.optimization_run_balance(uuid, timestamptz) from public;
revoke execute on function public.reserve_optimization_run(uuid, uuid, timestamptz, timestamptz, bigint) from public;
revoke execute on function public.settle_optimization_run(uuid) from public;
revoke execute on function public.reap_stale_optimization_runs(int) from public;
grant execute on function public.ensure_optimization_grant(uuid, timestamptz, timestamptz, bigint) to service_role;
grant execute on function public.optimization_run_balance(uuid, timestamptz) to service_role;
grant execute on function public.reserve_optimization_run(uuid, uuid, timestamptz, timestamptz, bigint) to service_role;
grant execute on function public.settle_optimization_run(uuid) to service_role;
grant execute on function public.reap_stale_optimization_runs(int) to service_role;
