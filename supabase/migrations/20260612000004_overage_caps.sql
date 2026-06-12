-- Opt-in Overage Caps (#183, ADR-0008). All plans hard-stop by default;
-- opting in IS setting a dollar cap ("allow up to $N/month") — never a bare
-- toggle. One cap per Team covers both platform meters: a negative ledger
-- balance is overage, priced at the plan's per-point / per-run rates, and a
-- reserve is allowed only while the PROJECTED overage across both meters
-- stays within the cap. The customer guarantee (ADR-0008): worst-case
-- invoice = subscription + the caps the Team typed themselves.
--
-- Settled overage (never mere reservations) is projected into
-- overage_invoice_lines — quantity only; pricing is applied at Stripe-push
-- time by the app from the plan constants — and pushed as invoice items.
--
-- Advisory-lock order, everywhere both meters are touched: points (key 0)
-- BEFORE runs (key 1). reserve_* with a cap, reconcile_plan_grants, and the
-- refresh helper all follow it; no path acquires 1 then 0.

-- ---------------------------------------------------------------------------
-- Team billing settings. A missing row (or a null cap) = overage off.
create table public.billing_settings (
  org_id          uuid primary key references public.organizations(id) on delete cascade,
  overage_cap_usd numeric(10, 2) check (overage_cap_usd > 0),
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);

alter table public.billing_settings enable row level security;
revoke all on public.billing_settings from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The invoice projection: one row per (period, meter), quantity = settled
-- usage beyond the period's grants. NOT source of truth (the ledgers are) and
-- NOT append-only — it is a derived, idempotently-recomputed snapshot. The
-- `dirty` flag marks rows whose quantity changed since the last Stripe push.
create table public.overage_invoice_lines (
  org_id                 uuid not null references public.organizations(id) on delete cascade,
  period_start           timestamptz not null,
  meter                  text not null check (meter in ('points', 'runs')),
  quantity               bigint not null check (quantity >= 0),
  stripe_invoice_item_id text,
  dirty                  boolean not null default true,
  updated_at             timestamptz not null default now(),
  primary key (org_id, period_start, meter)
);

alter table public.overage_invoice_lines enable row level security;
revoke all on public.overage_invoice_lines from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Recompute one meter's settled-overage line. Reentrant-safe: takes the
-- meter's own advisory lock (callers may already hold it). A line is created
-- only once real overage exists; afterwards it tracks the recomputed quantity
-- both ways (an 'upgrade' grant landing mid-period can SHRINK overage — the
-- push must then lower the Stripe item, so shrink marks dirty too).
create or replace function public.refresh_overage_line(
  p_org_id uuid,
  p_period_start timestamptz,
  p_meter text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_over bigint;
begin
  if p_meter = 'points' then
    perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));
    select greatest(
      0,
      coalesce(sum(points) filter (where entry_type = 'settle'), 0)
      - coalesce(sum(points) filter (where entry_type in ('grant', 'upgrade')), 0)
    ) into v_over
    from point_ledger
    where org_id = p_org_id and period_start = p_period_start;
  elsif p_meter = 'runs' then
    perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 1));
    select greatest(
      0,
      coalesce(sum(units) filter (where entry_type = 'settle'), 0)
      - coalesce(sum(units) filter (where entry_type in ('grant', 'upgrade')), 0)
    ) into v_over
    from optimization_run_ledger
    where org_id = p_org_id and period_start = p_period_start;
  else
    raise exception 'refresh_overage_line: unknown meter %', p_meter;
  end if;

  if v_over > 0 then
    insert into overage_invoice_lines (org_id, period_start, meter, quantity)
    values (p_org_id, p_period_start, p_meter, v_over)
    on conflict (org_id, period_start, meter) do update
      set quantity   = excluded.quantity,
          dirty      = overage_invoice_lines.dirty
                       or overage_invoice_lines.quantity is distinct from excluded.quantity,
          updated_at = now();
  else
    update overage_invoice_lines
    set quantity = 0, dirty = true, updated_at = now()
    where org_id = p_org_id
      and period_start = p_period_start
      and meter = p_meter
      and quantity <> 0;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Projected platform overage in dollars if the points balance dropped to
-- p_point_balance and the runs balance to p_run_balance. Pure cap math, split
-- out so the two reserve functions can't drift.
create or replace function public.projected_overage_usd(
  p_point_balance bigint,
  p_run_balance bigint,
  p_point_unit_usd numeric,
  p_run_unit_usd numeric
) returns numeric
language sql
immutable
as $$
  select greatest(0, -p_point_balance) * p_point_unit_usd
       + greatest(0, -p_run_balance) * p_run_unit_usd;
$$;

-- ---------------------------------------------------------------------------
-- Cap-aware point reserve. The old signature is dropped (PostgREST would
-- otherwise see an ambiguous overload). Without a cap the behavior is exactly
-- S3's: refuse past the balance. With one, the reserve may take the balance
-- negative as long as the projected overage across BOTH meters fits the cap —
-- checked under both advisory locks (0 then 1), so concurrent reserves on
-- either meter can never jointly overshoot it.
drop function public.reserve_eval_points(uuid, uuid, bigint, timestamptz, timestamptz, bigint, jsonb);

create function public.reserve_eval_points(
  p_org_id uuid,
  p_run_id uuid,
  p_cost bigint,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_included bigint,
  p_meta jsonb default '{}'::jsonb,
  p_cap_usd numeric default null,
  p_point_unit_usd numeric default null,
  p_run_unit_usd numeric default null
) returns table (reserved boolean, balance bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance bigint;
  v_run_balance bigint;
begin
  if p_cost < 0 then
    raise exception 'reserve_eval_points: negative cost %', p_cost;
  end if;
  if p_cap_usd is not null and (p_point_unit_usd is null or p_run_unit_usd is null) then
    raise exception 'reserve_eval_points: cap requires both unit rates';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));
  if p_cap_usd is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 1));
  end if;

  perform ensure_point_grant(p_org_id, p_period_start, p_period_end, p_included);

  v_balance := point_balance(p_org_id, p_period_start);
  if p_cost > v_balance then
    if p_cap_usd is null then
      return query select false, v_balance;
      return;
    end if;
    v_run_balance := optimization_run_balance(p_org_id, p_period_start);
    if projected_overage_usd(
         v_balance - p_cost, v_run_balance, p_point_unit_usd, p_run_unit_usd
       ) > p_cap_usd then
      return query select false, v_balance;
      return;
    end if;
  end if;

  insert into point_ledger (org_id, entry_type, points, eval_run_id, period_start, period_end, meta)
  values (p_org_id, 'reserve', p_cost, p_run_id, p_period_start, p_period_end, p_meta);

  return query select true, v_balance - p_cost;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cap-aware run reserve, same shape. Lock order with a cap: 0 then 1.
drop function public.reserve_optimization_run(uuid, uuid, timestamptz, timestamptz, bigint);

create function public.reserve_optimization_run(
  p_org_id uuid,
  p_run_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_included bigint,
  p_cap_usd numeric default null,
  p_point_unit_usd numeric default null,
  p_run_unit_usd numeric default null
) returns table (reserved boolean, balance bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance bigint;
  v_point_balance bigint;
begin
  if p_cap_usd is not null and (p_point_unit_usd is null or p_run_unit_usd is null) then
    raise exception 'reserve_optimization_run: cap requires both unit rates';
  end if;

  if p_cap_usd is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 1));

  perform ensure_optimization_grant(p_org_id, p_period_start, p_period_end, p_included);

  v_balance := optimization_run_balance(p_org_id, p_period_start);
  if v_balance < 1 then
    if p_cap_usd is null then
      return query select false, v_balance;
      return;
    end if;
    v_point_balance := point_balance(p_org_id, p_period_start);
    if projected_overage_usd(
         v_point_balance, v_balance - 1, p_point_unit_usd, p_run_unit_usd
       ) > p_cap_usd then
      return query select false, v_balance;
      return;
    end if;
  end if;

  insert into optimization_run_ledger (org_id, entry_type, units, opt_run_id, period_start, period_end)
  values (p_org_id, 'reserve', 1, p_run_id, p_period_start, p_period_end);

  return query select true, v_balance - 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Settles learn to maintain the invoice projection. Bodies are S3/S4/S5
-- verbatim plus the refresh_overage_line call at the end of the
-- something-was-written path (early returns changed nothing, so no refresh).
create or replace function public.settle_eval_run_points(
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
    raise exception 'settle_eval_run_points: unknown outcome %', p_outcome;
  end if;

  select * into r
  from point_ledger
  where eval_run_id = p_run_id and entry_type = 'reserve';
  if not found then
    return;
  end if;

  -- A reservation settles exactly once. Without this guard, a replay with a
  -- DIFFERENT outcome would no-op the settle insert but still compute a fresh
  -- release — minting back points the first settlement recorded as consumed.
  if exists (
    select 1 from point_ledger
    where eval_run_id = p_run_id and entry_type = 'settle'
  ) then
    return;
  end if;

  if p_outcome = 'completed' then
    v_actual := r.points;
  elsif p_outcome = 'skipped' then
    v_actual := 0;
  else
    -- Failed: charge what was demonstrably scored. The worker currently writes
    -- results only after a fully-successful evaluation, so today this settles 0
    -- and releases everything — deliberately generous (never overcharge a
    -- failure). If per-row result writes land later, actuals activate here
    -- automatically. A reservation missing per_row_cost also settles free, by
    -- the same never-overcharge rule.
    select count(distinct row_index) into v_scored
    from eval_run_results
    where eval_run_id = p_run_id;
    v_actual := least(
      v_scored * coalesce((r.meta ->> 'per_row_cost')::bigint, 0),
      r.points
    );
  end if;

  insert into point_ledger (org_id, entry_type, points, eval_run_id, period_start, period_end, meta)
  values (r.org_id, 'settle', v_actual, p_run_id, r.period_start, r.period_end,
          jsonb_build_object('outcome', p_outcome))
  on conflict (eval_run_id) where (entry_type = 'settle') do nothing;

  if r.points - v_actual > 0 then
    insert into point_ledger (org_id, entry_type, points, eval_run_id, period_start, period_end)
    values (r.org_id, 'release', r.points - v_actual, p_run_id, r.period_start, r.period_end)
    on conflict (eval_run_id) where (entry_type = 'release') do nothing;
  end if;

  -- Overage projection (#183): settled usage beyond grants becomes (or
  -- updates) the period's invoice line.
  perform refresh_overage_line(r.org_id, r.period_start, 'points');
end;
$$;

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

  perform pg_advisory_xact_lock(hashtextextended(r.org_id::text, 1));

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

  -- Overage projection (#183).
  perform refresh_overage_line(r.org_id, r.period_start, 'runs');
end;
$$;

-- ---------------------------------------------------------------------------
-- Grant reconciliation (S5) learns the same: a mid-period 'upgrade' grant can
-- SHRINK settled overage (more included), so the lines must be recomputed —
-- never leave a stale higher quantity that would overbill. Body is S5
-- verbatim plus the two refresh calls (locks 0 and 1 already held, in order).
create or replace function public.reconcile_plan_grants(
  p_org_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_included_points bigint,
  p_included_runs bigint
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_granted bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 1));

  perform ensure_point_grant(p_org_id, p_period_start, p_period_end, p_included_points);
  select coalesce(sum(points), 0) into v_granted
  from point_ledger
  where org_id = p_org_id
    and period_start = p_period_start
    and entry_type in ('grant', 'upgrade');
  if p_included_points > v_granted then
    insert into point_ledger (org_id, entry_type, points, period_start, period_end, meta)
    values (p_org_id, 'upgrade', p_included_points - v_granted, p_period_start, p_period_end,
            jsonb_build_object('included', p_included_points));
  end if;

  perform ensure_optimization_grant(p_org_id, p_period_start, p_period_end, p_included_runs);
  select coalesce(sum(units), 0) into v_granted
  from optimization_run_ledger
  where org_id = p_org_id
    and period_start = p_period_start
    and entry_type in ('grant', 'upgrade');
  if p_included_runs > v_granted then
    insert into optimization_run_ledger (org_id, entry_type, units, period_start, period_end, meta)
    values (p_org_id, 'upgrade', p_included_runs - v_granted, p_period_start, p_period_end,
            jsonb_build_object('included', p_included_runs));
  end if;

  perform refresh_overage_line(p_org_id, p_period_start, 'points');
  perform refresh_overage_line(p_org_id, p_period_start, 'runs');
end;
$$;

-- ---------------------------------------------------------------------------
revoke execute on function public.refresh_overage_line(uuid, timestamptz, text) from public;
revoke execute on function public.projected_overage_usd(bigint, bigint, numeric, numeric) from public;
revoke execute on function public.reserve_eval_points(uuid, uuid, bigint, timestamptz, timestamptz, bigint, jsonb, numeric, numeric, numeric) from public;
revoke execute on function public.reserve_optimization_run(uuid, uuid, timestamptz, timestamptz, bigint, numeric, numeric, numeric) from public;
grant execute on function public.refresh_overage_line(uuid, timestamptz, text) to service_role;
grant execute on function public.projected_overage_usd(bigint, bigint, numeric, numeric) to service_role;
grant execute on function public.reserve_eval_points(uuid, uuid, bigint, timestamptz, timestamptz, bigint, jsonb, numeric, numeric, numeric) to service_role;
grant execute on function public.reserve_optimization_run(uuid, uuid, timestamptz, timestamptz, bigint, numeric, numeric, numeric) to service_role;