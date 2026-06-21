-- Point Ledger (#180, ADR-0009): the append-only record of Eval Point activity.
-- A Team's balance is never a mutable column — it is always the sum of this
-- ledger, computed with the per-type signs in point_balance(). Entries:
--
--   grant    +points   the period's included allotment (one per org per period)
--   reserve  -points   an Eval Run's exact cost, taken atomically at creation
--   settle    0        closes a reservation; points = what was actually consumed
--   release  +points   returns the unconsumed remainder of a reservation
--
-- settle is balance-neutral by design: the reservation already debited the
-- full cost, so settlement only records consumption (and release returns the
-- rest). Settle/release copy the reservation's period columns, so a run that
-- crosses a period boundary settles against its origin period (ADR-0008).

create table public.point_ledger (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  entry_type   text not null check (entry_type in ('grant', 'reserve', 'settle', 'release')),
  -- Magnitude, always >= 0; the sign lives in the entry_type (see point_balance).
  points       bigint not null check (points >= 0),
  eval_run_id  uuid references public.eval_runs(id) on delete set null,
  period_start timestamptz not null,
  period_end   timestamptz not null,
  -- Reservation context. `per_row_cost` on a reserve entry IS authoritative for
  -- the failed-settle arm: it freezes pricing at reservation time, so an
  -- in-flight run is never re-priced by a knob change. The rest is display-only.
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

-- One grant per org per period: the lazy ensure_point_grant() is idempotent
-- because this index makes the second insert a no-op — a Free Team created on
-- the last day of a month can never double-grant across a calendar boundary.
create unique index point_ledger_one_grant_per_period
  on public.point_ledger (org_id, period_start)
  where (entry_type = 'grant');

-- At most one reservation / settlement / release per run.
create unique index point_ledger_one_reserve_per_run
  on public.point_ledger (eval_run_id)
  where (entry_type = 'reserve');
create unique index point_ledger_one_settle_per_run
  on public.point_ledger (eval_run_id)
  where (entry_type = 'settle');
create unique index point_ledger_one_release_per_run
  on public.point_ledger (eval_run_id)
  where (entry_type = 'release');

create index point_ledger_org_period_idx
  on public.point_ledger (org_id, period_start, created_at desc);

alter table public.point_ledger enable row level security;

-- Append-only at the grant level, not just by convention: nothing — including
-- the service role — can UPDATE or DELETE entries. Corrections are new entries.
revoke all on public.point_ledger from public, anon, authenticated;
revoke update, delete, truncate on public.point_ledger from service_role;

-- ---------------------------------------------------------------------------
-- Lazily materialise the current period's grant. Idempotent via the partial
-- unique index; callers always pass the period they resolved app-side (the
-- Stripe period for paid Teams, the creation-anniversary period for Free).
create or replace function public.ensure_point_grant(
  p_org_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_included bigint
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into point_ledger (org_id, entry_type, points, period_start, period_end)
  values (p_org_id, 'grant', p_included, p_period_start, p_period_end)
  on conflict (org_id, period_start) where (entry_type = 'grant') do nothing;
$$;

-- The balance for one period: signed sum of the ledger. No rollover — entries
-- belong to exactly one period and the sum never reaches across periods.
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
        when 'release' then points
        when 'reserve' then -points
        else 0  -- settle: balance-neutral closure of a reservation
      end
    ),
    0
  )
  from point_ledger
  where org_id = p_org_id
    and period_start = p_period_start;
$$;

-- Atomic reserve: the balance check and the reservation insert happen under a
-- per-org transaction-scoped advisory lock, so concurrent run creations can
-- never jointly exceed the balance. Returns whether the reservation was taken
-- and the balance AFTER the call either way (the refusal path reports
-- "needed X, have Y" from the same snapshot the decision used).
create or replace function public.reserve_eval_points(
  p_org_id uuid,
  p_run_id uuid,
  p_cost bigint,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_included bigint,
  p_meta jsonb default '{}'::jsonb
) returns table (reserved boolean, balance bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance bigint;
begin
  if p_cost < 0 then
    raise exception 'reserve_eval_points: negative cost %', p_cost;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));
  perform ensure_point_grant(p_org_id, p_period_start, p_period_end, p_included);

  v_balance := point_balance(p_org_id, p_period_start);
  if p_cost > v_balance then
    return query select false, v_balance;
    return;
  end if;

  insert into point_ledger (org_id, entry_type, points, eval_run_id, period_start, period_end, meta)
  values (p_org_id, 'reserve', p_cost, p_run_id, p_period_start, p_period_end, p_meta);

  return query select true, v_balance - p_cost;
end;
$$;

-- Settle a run's reservation at its terminal state. Idempotent (the partial
-- unique indexes make replays no-ops) and a no-op for runs with no reservation
-- (pre-ledger runs, schedule-spawned runs not yet metered).
--   completed -> the full reservation was consumed
--   skipped   -> nothing was consumed; release everything
--   failed    -> consumption = scored rows x per-row cost from the reservation
--                meta, capped at the reservation (settlement never exceeds it)
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
end;
$$;

-- Server-side only, like the queue functions: the app and worker hold the
-- service key; clients never touch the ledger directly.
revoke execute on function public.ensure_point_grant(uuid, timestamptz, timestamptz, bigint) from public;
revoke execute on function public.point_balance(uuid, timestamptz) from public;
revoke execute on function public.reserve_eval_points(uuid, uuid, bigint, timestamptz, timestamptz, bigint, jsonb) from public;
revoke execute on function public.settle_eval_run_points(uuid, text) from public;
grant execute on function public.ensure_point_grant(uuid, timestamptz, timestamptz, bigint) to service_role;
grant execute on function public.point_balance(uuid, timestamptz) to service_role;
grant execute on function public.reserve_eval_points(uuid, uuid, bigint, timestamptz, timestamptz, bigint, jsonb) to service_role;
grant execute on function public.settle_eval_run_points(uuid, text) to service_role;
