-- Managed Key gateway metering & Managed Spend Cap (#185, ADR-0008 Meter 2).
--
-- Meter 2 is managed token spend, in dollars, billed separately from Eval
-- Points at cost × (1 + plan markup). Every managed LLM call (judge/reflect on
-- a platform key, when a paid Team has no BYO key for the provider) accrues an
-- append-only row carrying the token counts and the SNAPSHOTTED unit prices +
-- markup, so repricing the code-side price table never rewrites billed history.
--
-- The Managed Spend Cap is a per-Team hard monthly ceiling (defaulted per plan
-- in code: Builder $25 / Scale $100, raisable). It is enforced PRE-RUN against a
-- per-model dollar estimate (reserve_managed_spend, app side) and MID-RUN against
-- accrued actuals (the worker checks the running total accrue returns). Free
-- Teams never reach managed (no card on file, ADR-0008) so they never accrue.
--
-- Advisory-lock keyspace: points = 0, runs = 1 (existing). Managed claims
-- keyspace 2 — its reserve serializes per-org so concurrent runs can never
-- JOINTLY overshoot the cap. No path crosses keyspace 2 with 0/1, so ordering
-- against the platform meters is moot here.

-- ---------------------------------------------------------------------------
-- The Managed Spend Cap OVERRIDE. The effective cap is this value when set,
-- else the plan default (resolved app-side from PLANS[plan].defaultManagedSpendCapUsd).
-- A missing column / null = "use the plan default", never "uncapped" — a paid
-- plan always has a default, so managed spend is never unbounded.
alter table public.billing_settings
  add column managed_spend_cap_usd numeric(10, 2) check (managed_spend_cap_usd > 0);

-- ---------------------------------------------------------------------------
-- The managed-spend ledger. Append-only record of Meter 2 activity. Dollars,
-- not points; the period's committed spend is the signed sum of this ledger.
--
--   reserve  +amount   a run's pre-run dollar ESTIMATE, taken atomically at
--                       creation under the cap (app side, reserve_managed_spend)
--   accrue   +amount   one managed LLM call's ACTUAL cost (incl. markup), with
--                       provider/model/tokens/snapshotted unit prices (worker)
--   release  -amount   returns a run's outstanding reservation at settle, so the
--                       committed total converges to accrued actuals
--
-- Committed (for the cap) = Σreserve − Σrelease + Σaccrue. A run in flight thus
-- holds both its estimate and its growing actuals — deliberately conservative
-- (fail-closed). On settle the release cancels the estimate, leaving actuals.
create table public.managed_spend_ledger (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  entry_type      text not null check (entry_type in ('reserve', 'accrue', 'release')),
  -- Magnitude in USD, always >= 0; the sign lives in the entry_type.
  amount_usd      numeric(14, 6) not null check (amount_usd >= 0),
  -- Exactly one run reference per row (eval OR optimization).
  eval_run_id     uuid references public.eval_runs(id) on delete set null,
  opt_run_id      uuid references public.optimization_runs(id) on delete set null,
  -- accrue-only audit columns (null on reserve/release). All SNAPSHOTTED.
  provider        text,
  model           text,
  input_tokens    bigint check (input_tokens is null or input_tokens >= 0),
  output_tokens   bigint check (output_tokens is null or output_tokens >= 0),
  input_unit_usd  numeric(20, 12),
  output_unit_usd numeric(20, 12),
  -- markup_pct is snapshotted on BOTH the reserve row (freezes the run's pricing
  -- + cap for the worker, model-independent) and each accrue row (the rate the
  -- call was billed at). cap_usd is reserve-only: the effective cap the run was
  -- admitted under, which the worker reads back for its mid-run check.
  markup_pct      numeric(6, 3),
  cap_usd         numeric(10, 2),
  call_kind       text check (call_kind is null or call_kind in ('judge', 'reflect')),
  period_start    timestamptz not null,
  period_end      timestamptz not null,
  created_at      timestamptz not null default now(),
  -- A run reference may be null only after the run row is deleted (on delete set
  -- null); a fresh row always names exactly one run.
  constraint managed_spend_ledger_one_run
    check (num_nonnulls(eval_run_id, opt_run_id) <= 1)
);

create index managed_spend_ledger_org_period_idx
  on public.managed_spend_ledger (org_id, period_start, created_at desc);
create index managed_spend_ledger_eval_run_idx
  on public.managed_spend_ledger (eval_run_id) where (eval_run_id is not null);
create index managed_spend_ledger_opt_run_idx
  on public.managed_spend_ledger (opt_run_id) where (opt_run_id is not null);

alter table public.managed_spend_ledger enable row level security;

-- Append-only, enforced not just by convention: nothing — including the service
-- role — can UPDATE or DELETE. A "release" is a NEW row, never a mutation, so
-- billed history is immutable. (RLS with no policy already denies anon/authenticated;
-- the ALTER DEFAULT PRIVILEGES note from the dashboard_runs migration is why we
-- revoke from service_role explicitly rather than trusting revoke-from-public.)
revoke all on public.managed_spend_ledger from public, anon, authenticated;
revoke update, delete, truncate on public.managed_spend_ledger from service_role;

-- ---------------------------------------------------------------------------
-- The period's accrued managed spend (actuals only) — the usage view's number
-- and the worker's mid-run comparison base.
create or replace function public.managed_spend_total(
  p_org_id uuid,
  p_period_start timestamptz
) returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(amount_usd) filter (where entry_type = 'accrue'), 0)
  from managed_spend_ledger
  where org_id = p_org_id and period_start = p_period_start;
$$;

-- ---------------------------------------------------------------------------
-- Atomic pre-run reservation against the Managed Spend Cap. Under the per-org
-- managed lock (keyspace 2), the committed total (Σreserve − Σrelease + Σaccrue)
-- plus this run's estimate must fit the cap, or the reservation is refused.
-- Serializing on the lock is what stops two concurrent runs from jointly
-- overshooting. cap_usd is the EFFECTIVE cap the app resolved (override or plan
-- default); it is passed in, not read here, because it lives in code constants.
create or replace function public.reserve_managed_spend(
  p_org_id uuid,
  p_estimate_usd numeric,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_cap_usd numeric,
  p_markup_pct numeric,
  p_eval_run_id uuid default null,
  p_opt_run_id uuid default null
) returns table (reserved boolean, committed_usd numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_committed numeric;
begin
  if p_estimate_usd < 0 then
    raise exception 'reserve_managed_spend: negative estimate %', p_estimate_usd;
  end if;
  if num_nonnulls(p_eval_run_id, p_opt_run_id) <> 1 then
    raise exception 'reserve_managed_spend: exactly one run id required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 2));

  select coalesce(sum(
    case entry_type
      when 'reserve' then amount_usd
      when 'accrue'  then amount_usd
      when 'release' then -amount_usd
    end
  ), 0)
  into v_committed
  from managed_spend_ledger
  where org_id = p_org_id and period_start = p_period_start;

  -- No cap should never happen for a managed run (paid plans always default a
  -- cap), but fail closed if one is somehow absent.
  if p_cap_usd is null or v_committed + p_estimate_usd > p_cap_usd then
    return query select false, v_committed;
    return;
  end if;

  -- Snapshot markup_pct + cap_usd on the reserve row: the worker reads them back
  -- for cost computation and the mid-run cap check, model-independent and frozen
  -- for this run even if the Team changes the cap mid-flight.
  insert into managed_spend_ledger
    (org_id, entry_type, amount_usd, eval_run_id, opt_run_id, markup_pct, cap_usd, period_start, period_end)
  values
    (p_org_id, 'reserve', p_estimate_usd, p_eval_run_id, p_opt_run_id, p_markup_pct, p_cap_usd, p_period_start, p_period_end);

  return query select true, v_committed + p_estimate_usd;
end;
$$;

-- ---------------------------------------------------------------------------
-- Record one managed call's actual cost (append-only). The period is derived
-- from the run's existing PLATFORM reserve entry (point_ledger for eval runs,
-- optimization_run_ledger for optimization runs) so the worker never recomputes
-- it — managed accruals always settle against the run's origin period. Returns
-- the period's running accrued total for the worker's mid-run cap check.
create or replace function public.accrue_managed_spend(
  p_org_id uuid,
  p_amount_usd numeric,
  p_provider text,
  p_model text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_input_unit_usd numeric,
  p_output_unit_usd numeric,
  p_markup_pct numeric,
  p_call_kind text,
  p_eval_run_id uuid default null,
  p_opt_run_id uuid default null
) returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ps timestamptz;
  v_pe timestamptz;
begin
  if num_nonnulls(p_eval_run_id, p_opt_run_id) <> 1 then
    raise exception 'accrue_managed_spend: exactly one run id required';
  end if;

  if p_eval_run_id is not null then
    select period_start, period_end into v_ps, v_pe
    from point_ledger
    where eval_run_id = p_eval_run_id and entry_type = 'reserve'
    limit 1;
  else
    select period_start, period_end into v_ps, v_pe
    from optimization_run_ledger
    where opt_run_id = p_opt_run_id and entry_type = 'reserve'
    limit 1;
  end if;

  if v_ps is null then
    raise exception 'accrue_managed_spend: no platform reserve found for run';
  end if;

  insert into managed_spend_ledger
    (org_id, entry_type, amount_usd, eval_run_id, opt_run_id,
     provider, model, input_tokens, output_tokens,
     input_unit_usd, output_unit_usd, markup_pct, call_kind,
     period_start, period_end)
  values
    (p_org_id, 'accrue', p_amount_usd, p_eval_run_id, p_opt_run_id,
     p_provider, p_model, p_input_tokens, p_output_tokens,
     p_input_unit_usd, p_output_unit_usd, p_markup_pct, p_call_kind,
     v_ps, v_pe);

  return public.managed_spend_total(p_org_id, v_ps);
end;
$$;

-- ---------------------------------------------------------------------------
-- Release a run's outstanding reservation at settle. Inserts a single release
-- equal to the run's net reserved-minus-released amount, so committed converges
-- to the run's actual accruals. Idempotent: a second call nets to zero and
-- inserts nothing.
create or replace function public.release_managed_reservation(
  p_eval_run_id uuid default null,
  p_opt_run_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_outstanding numeric;
begin
  if num_nonnulls(p_eval_run_id, p_opt_run_id) <> 1 then
    raise exception 'release_managed_reservation: exactly one run id required';
  end if;

  select org_id, period_start, period_end into r
  from managed_spend_ledger
  where entry_type = 'reserve'
    and ((p_eval_run_id is not null and eval_run_id = p_eval_run_id)
      or (p_opt_run_id is not null and opt_run_id = p_opt_run_id))
  limit 1;
  if not found then
    return; -- BYO or unpriced run: never reserved, nothing to release.
  end if;

  perform pg_advisory_xact_lock(hashtextextended(r.org_id::text, 2));

  select coalesce(sum(
    case entry_type when 'reserve' then amount_usd when 'release' then -amount_usd else 0 end
  ), 0)
  into v_outstanding
  from managed_spend_ledger
  where ((p_eval_run_id is not null and eval_run_id = p_eval_run_id)
      or (p_opt_run_id is not null and opt_run_id = p_opt_run_id));

  if v_outstanding > 0 then
    insert into managed_spend_ledger
      (org_id, entry_type, amount_usd, eval_run_id, opt_run_id, period_start, period_end)
    values
      (r.org_id, 'release', v_outstanding, p_eval_run_id, p_opt_run_id, r.period_start, r.period_end);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Service-role only (the worker and server actions run as service_role; the
-- ALTER DEFAULT PRIVILEGES caveat means revoke-from-public alone is insufficient).
revoke execute on function public.managed_spend_total(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.reserve_managed_spend(uuid, numeric, timestamptz, timestamptz, numeric, numeric, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.accrue_managed_spend(uuid, numeric, text, text, bigint, bigint, numeric, numeric, numeric, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.release_managed_reservation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.managed_spend_total(uuid, timestamptz) to service_role;
grant execute on function public.reserve_managed_spend(uuid, numeric, timestamptz, timestamptz, numeric, numeric, uuid, uuid) to service_role;
grant execute on function public.accrue_managed_spend(uuid, numeric, text, text, bigint, bigint, numeric, numeric, numeric, text, uuid, uuid) to service_role;
grant execute on function public.release_managed_reservation(uuid, uuid) to service_role;
