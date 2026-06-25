-- Optimization Runs meter as Eval Points past the included run allowance
-- (ADR-0016, supersedes ADR-0008's Meter-1 optimization clause). The included
-- per-plan run-count allowance STAYS as the included benefit (one unit per run,
-- hard-stop at zero); once a paid Team exhausts it, an additional run reserves
-- worst-case POINTS on the same point_ledger instead of hard-blocking. Free is
-- unchanged: 0 included runs, no points-overage path (the app keeps the wall).
--
-- An optimization run's point cost mirrors the eval formula, per scored rollout:
--   reserve  = budget_rollouts × (base + per_criterion × |criteria|)   (worst case, at create)
--   settle   = scored_rollouts × (base + per_criterion × |criteria|)   (actual, at terminal)
--   release  = the unconsumed remainder
-- Unlike the eval settle, COMPLETED also settles to the actual scored count:
-- the reservation is the budget ceiling, and a run almost always scores fewer
-- rollouts than its budget (the loops stop early).
--
-- Consequence: optimization overage now lives entirely on the point meter, so
-- the run-count ledger never goes negative and the flat dollars-per-run overage
-- (optimizationRunOverageUsd) is retired. projected_overage_usd collapses to a
-- single (points) term.

-- ---------------------------------------------------------------------------
-- The point ledger now records optimization-run point activity too. Opt-run
-- entries carry opt_run_id (eval_run_id null) and vice versa, so the existing
-- eval_run_id partial indexes never collide with them (NULLs are distinct).
alter table public.point_ledger
  add column opt_run_id uuid references public.optimization_runs(id) on delete set null;

create unique index point_ledger_one_opt_reserve_per_run
  on public.point_ledger (opt_run_id)
  where (entry_type = 'reserve' and opt_run_id is not null);
create unique index point_ledger_one_opt_settle_per_run
  on public.point_ledger (opt_run_id)
  where (entry_type = 'settle' and opt_run_id is not null);
create unique index point_ledger_one_opt_release_per_run
  on public.point_ledger (opt_run_id)
  where (entry_type = 'release' and opt_run_id is not null);

-- ---------------------------------------------------------------------------
-- Points-only projection: optimization overage is now points, so the runs term
-- is gone. The run-count ledger no longer goes negative (it hard-stops at 0),
-- so a single (points) balance × rate is the whole committed overage.
drop function public.projected_overage_usd(bigint, bigint, numeric, numeric);

create function public.projected_overage_usd(
  p_point_balance bigint,
  p_point_unit_usd numeric
) returns numeric
language sql
immutable
as $$
  select greatest(0, -p_point_balance) * p_point_unit_usd;
$$;

-- ---------------------------------------------------------------------------
-- Cap-aware point reserve, points-only. Same contract as before but the cap
-- check no longer reaches across to the run meter: committed overage is purely
-- the (possibly negative) point balance × the point rate. Without a cap it
-- refuses past balance; with one it may dig negative while projected overage
-- fits the cap. The run meter is never touched, so only lock 0 is taken.
drop function public.reserve_eval_points(uuid, uuid, bigint, timestamptz, timestamptz, bigint, jsonb, numeric, numeric);

create function public.reserve_eval_points(
  p_org_id uuid,
  p_run_id uuid,
  p_cost bigint,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_included bigint,
  p_meta jsonb default '{}'::jsonb,
  p_point_unit_usd numeric default null
) returns table (reserved boolean, balance bigint, cap_usd numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance bigint;
  v_cap numeric;
begin
  if p_cost < 0 then
    raise exception 'reserve_eval_points: negative cost %', p_cost;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));
  perform ensure_point_grant(p_org_id, p_period_start, p_period_end, p_included);

  -- A plan with overage passes its point rate; null = hard-stop (Free, or a
  -- payment-failing Team whose rate the app suppresses).
  if p_point_unit_usd is not null then
    select overage_cap_usd into v_cap from billing_settings where org_id = p_org_id;
  end if;

  v_balance := point_balance(p_org_id, p_period_start);
  if p_cost > v_balance then
    if v_cap is null then
      return query select false, v_balance, v_cap;
      return;
    end if;
    if projected_overage_usd(v_balance - p_cost, p_point_unit_usd) > v_cap then
      return query select false, v_balance, v_cap;
      return;
    end if;
  end if;

  insert into point_ledger (org_id, entry_type, points, eval_run_id, period_start, period_end, meta)
  values (p_org_id, 'reserve', p_cost, p_run_id, p_period_start, p_period_end, p_meta);

  return query select true, v_balance - p_cost, v_cap;
end;
$$;

-- ---------------------------------------------------------------------------
-- The run-count reserve is back to a plain hard-stop unit counter: the included
-- allowance is the whole benefit, and overage is metered in points elsewhere,
-- so this never goes negative and needs no cap/rate plumbing. It is only ever
-- called within allowance now (the start gate switches to points past zero).
drop function public.reserve_optimization_run(uuid, uuid, timestamptz, timestamptz, bigint, numeric, numeric);

create function public.reserve_optimization_run(
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

-- ---------------------------------------------------------------------------
-- Worst-case point reserve for an OVERAGE optimization run (paid Teams past
-- their included run-count). A clone of reserve_eval_points writing opt_run_id
-- on the point meter; p_included is the period's POINT grant (includedEvalPoints),
-- p_cost = budget_rollouts × per_rollout_cost, p_meta carries per_rollout_cost
-- so the settle freezes pricing at reservation time.
create function public.reserve_optimization_points(
  p_org_id uuid,
  p_run_id uuid,
  p_cost bigint,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_included bigint,
  p_meta jsonb default '{}'::jsonb,
  p_point_unit_usd numeric default null
) returns table (reserved boolean, balance bigint, cap_usd numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance bigint;
  v_cap numeric;
begin
  if p_cost < 0 then
    raise exception 'reserve_optimization_points: negative cost %', p_cost;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));
  perform ensure_point_grant(p_org_id, p_period_start, p_period_end, p_included);

  if p_point_unit_usd is not null then
    select overage_cap_usd into v_cap from billing_settings where org_id = p_org_id;
  end if;

  v_balance := point_balance(p_org_id, p_period_start);
  if p_cost > v_balance then
    if v_cap is null then
      return query select false, v_balance, v_cap;
      return;
    end if;
    if projected_overage_usd(v_balance - p_cost, p_point_unit_usd) > v_cap then
      return query select false, v_balance, v_cap;
      return;
    end if;
  end if;

  insert into point_ledger (org_id, entry_type, points, opt_run_id, period_start, period_end, meta)
  values (p_org_id, 'reserve', p_cost, p_run_id, p_period_start, p_period_end, p_meta);

  return query select true, v_balance - p_cost, v_cap;
end;
$$;

-- ---------------------------------------------------------------------------
-- Settle an optimization run's POINT reservation at terminal state. Mirrors
-- settle_eval_run_points, but BOTH completed and failed settle to the actual
-- scored rollouts (the reservation is the budget ceiling, not an exact cost):
--   completed/failed  least(scored_rollouts × per_rollout_cost, reserved), release rest
--   skipped           0, release all
-- scored_rollouts = distinct rollouts that produced at least one judged result.
-- Idempotent (settled guard + partial unique index), serialized by the points
-- advisory lock, a no-op for runs with no point reservation (within-allowance).
create function public.settle_optimization_run_points(
  p_run_id uuid,
  p_outcome text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_scored bigint;
  v_actual bigint;
begin
  if p_outcome not in ('completed', 'failed', 'skipped') then
    raise exception 'settle_optimization_run_points: unknown outcome %', p_outcome;
  end if;

  select * into r
  from point_ledger
  where opt_run_id = p_run_id and entry_type = 'reserve';
  if not found then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(r.org_id::text, 0));

  if exists (
    select 1 from point_ledger
    where opt_run_id = p_run_id and entry_type = 'settle'
  ) then
    return;
  end if;

  if p_outcome = 'skipped' then
    v_actual := 0;
  else
    select count(distinct ro.id) into v_scored
    from rollout_results rr
    join optimization_rollouts ro on ro.id = rr.rollout_id
    join optimization_candidates c on c.id = ro.candidate_id
    where c.opt_run_id = p_run_id;
    v_actual := least(
      v_scored * coalesce((r.meta ->> 'per_rollout_cost')::bigint, 0),
      r.points
    );
  end if;

  insert into point_ledger (org_id, entry_type, points, opt_run_id, period_start, period_end, meta)
  values (r.org_id, 'settle', v_actual, p_run_id, r.period_start, r.period_end,
          jsonb_build_object('outcome', p_outcome))
  on conflict (opt_run_id) where (entry_type = 'settle' and opt_run_id is not null) do nothing;

  if r.points - v_actual > 0 then
    insert into point_ledger (org_id, entry_type, points, opt_run_id, period_start, period_end)
    values (r.org_id, 'release', r.points - v_actual, p_run_id, r.period_start, r.period_end)
    on conflict (opt_run_id) where (entry_type = 'release' and opt_run_id is not null) do nothing;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The optimization reaper now also sweep-settles point reservations (overage
-- runs), alongside the run-unit sweep. Full redefinition of the #181 reaper.
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

  -- Run-unit settlement sweep (idempotent).
  perform public.settle_optimization_run(r.opt_run_id)
  from public.optimization_run_ledger r
  join public.optimization_runs o on o.id = r.opt_run_id
  where r.entry_type = 'reserve'
    and o.status in ('completed', 'failed')
    and not exists (
      select 1 from public.optimization_run_ledger s
      where s.opt_run_id = r.opt_run_id and s.entry_type = 'settle'
    );

  -- Point settlement sweep for overage runs (idempotent). The run's terminal
  -- status is the outcome; completed/failed both settle to scored rollouts.
  perform public.settle_optimization_run_points(r.opt_run_id, o.status::text)
  from public.point_ledger r
  join public.optimization_runs o on o.id = r.opt_run_id
  where r.entry_type = 'reserve'
    and r.opt_run_id is not null
    and o.status in ('completed', 'failed')
    and not exists (
      select 1 from public.point_ledger s
      where s.opt_run_id = r.opt_run_id and s.entry_type = 'settle'
    );

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Recreated functions lose their grants on drop; re-establish the
-- service_role-only execute, and re-assert the point_ledger append-only revoke
-- (defensive — a recreated function never re-opens table privileges, but the
-- append-only invariant is load-bearing, #207/20260615).
revoke execute on function public.projected_overage_usd(bigint, numeric) from public;
revoke execute on function public.reserve_eval_points(uuid, uuid, bigint, timestamptz, timestamptz, bigint, jsonb, numeric) from public;
revoke execute on function public.reserve_optimization_run(uuid, uuid, timestamptz, timestamptz, bigint) from public;
revoke execute on function public.reserve_optimization_points(uuid, uuid, bigint, timestamptz, timestamptz, bigint, jsonb, numeric) from public;
revoke execute on function public.settle_optimization_run_points(uuid, text) from public;
revoke execute on function public.reap_stale_optimization_runs(int) from public;

grant execute on function public.reserve_eval_points(uuid, uuid, bigint, timestamptz, timestamptz, bigint, jsonb, numeric) to service_role;
grant execute on function public.reserve_optimization_run(uuid, uuid, timestamptz, timestamptz, bigint) to service_role;
grant execute on function public.reserve_optimization_points(uuid, uuid, bigint, timestamptz, timestamptz, bigint, jsonb, numeric) to service_role;
grant execute on function public.settle_optimization_run_points(uuid, text) to service_role;
grant execute on function public.reap_stale_optimization_runs(int) to service_role;

revoke update, delete, truncate on public.point_ledger from service_role;
