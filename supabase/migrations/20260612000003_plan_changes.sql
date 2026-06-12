-- Plan-change lifecycle (#182, ADR-0008): upgrades apply immediately with a
-- prorated Stripe charge and a delta grant into the CURRENT period; downgrades
-- and cancellations are Stripe-scheduled for period end and reversible until
-- they execute. The mirror learns to carry the pending state so the billing
-- page can render "Builder until <date>, then Free".

alter table public.customers
  add column cancel_at_period_end boolean not null default false,
  add column pending_price_id     text,
  add column pending_change_at    timestamptz,
  add column stripe_schedule_id   text,
  -- Recency marker for subscription_schedule.* events — the pending fields'
  -- own mirror_event_at: Stripe doesn't guarantee delivery order, and a late
  -- `updated` must not resurrect pending state a `released` already cleared.
  add column schedule_event_at    timestamptz;

-- ---------------------------------------------------------------------------
-- 'upgrade' entries: mid-period delta grants. Multiple per period are legal
-- (up→down→up cycling), but the delta math below makes them non-exploitable.
alter table public.point_ledger
  drop constraint point_ledger_entry_type_check;
alter table public.point_ledger
  add constraint point_ledger_entry_type_check
  check (entry_type in ('grant', 'reserve', 'settle', 'release', 'upgrade'));

alter table public.optimization_run_ledger
  drop constraint optimization_run_ledger_entry_type_check;
alter table public.optimization_run_ledger
  add constraint optimization_run_ledger_entry_type_check
  check (entry_type in ('grant', 'reserve', 'settle', 'release', 'upgrade'));

-- Balances count upgrades as credits, alongside grants and releases.
create or replace function public.point_balance(
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
        when 'grant'   then points
        when 'upgrade' then points
        when 'release' then points
        when 'reserve' then -points
        else 0
      end
    ),
    0
  )
  from point_ledger
  where org_id = p_org_id
    and period_start = p_period_start;
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
        when 'upgrade' then units
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

-- ---------------------------------------------------------------------------
-- Reconcile a period's granted totals with the plan now in force. Called by
-- the webhook whenever an actively-paid subscription is mirrored:
--   - no grant yet (new period, or first activity) → the lazy grant lands at
--     the CURRENT plan's included amounts, exactly as before;
--   - grant exists and the plan grew mid-period (upgrade) → an 'upgrade' entry
--     for the delta BEYOND everything already granted this period. Cycling
--     up→down→up grants the delta once: the second upgrade sees the first
--     upgrade's entry in the sum and computes 0 (#182's anti-farming rule).
--   - downgrades mid-period → negative delta → no entry; grants are never
--     clawed back.
-- Idempotent and atomic under both meters' advisory locks (points key space 0
-- taken before runs key space 1, the same order everywhere — no deadlocks).
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
end;
$$;

revoke execute on function public.reconcile_plan_grants(uuid, timestamptz, timestamptz, bigint, bigint) from public;
grant execute on function public.reconcile_plan_grants(uuid, timestamptz, timestamptz, bigint, bigint) to service_role;
