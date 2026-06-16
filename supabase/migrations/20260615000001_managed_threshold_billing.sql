-- Managed-token invoice line & threshold billing (#186, ADR-0008 Meter 2, S9).
--
-- S8 (#185) built the accrual half: every managed LLM call appends an immutable
-- 'accrue' row to managed_spend_ledger (amount already includes markup, with the
-- provider/model/tokens/unit-prices snapshotted), and the Managed Spend Cap
-- hard-stops runs. S9 builds the BILLING + CREDIT-RISK half:
--
--   1. Itemized invoice line — accrued managed spend is pushed to Stripe as one
--      invoice item per (provider, model), priced at the snapshotted cost (which
--      already carries the markup). managed_invoice_lines is the derived mirror
--      that tracks how much of the ledger's accrued spend has been INVOICED, so
--      the live invoice never double-bills and reconciles to the ledger.
--
--   2. Threshold billing — when a Team's UN-invoiced accrued spend crosses a
--      fixed per-plan threshold (code constant, below the cap), an invoice is
--      created + finalized IMMEDIATELY rather than waiting for month-end, capping
--      the credit we ever extend at the threshold. A pg_cron sweep finds Teams
--      with un-invoiced spend and pokes an app route (Stripe lives app-side, never
--      in the DB or the worker); the route does the authoritative, code-side
--      threshold comparison and pushes the invoice.
--
--   3. Fail-closed for managed runs only — a declined managed-token invoice sets
--      managed_payment_failed_at on the mirror; the run gate refuses MANAGED runs
--      (BYO runs, the customer's own tokens, are unaffected) until the invoice is
--      paid, which the webhook clears automatically (no human in the loop).
--
-- The managed_spend_ledger stays the immutable source of truth; nothing here
-- mutates it. managed_invoice_lines is a derived, idempotently-recomputed mirror
-- (like overage_invoice_lines, #183) — NOT append-only — so service_role updates
-- it freely (auto-granted by 20260614000000's default privileges).

-- ---------------------------------------------------------------------------
-- The managed-payment-failed flag lives on the existing Stripe mirror, beside
-- the other webhook-owned subscription fields. It is INTENTIONALLY separate from
-- customers.status: a failed *managed-token* invoice must block managed runs
-- WITHOUT flipping the whole subscription to past_due (which would block BYO runs
-- and every other paid feature). Null = managed payments healthy.
alter table public.customers
  add column managed_payment_failed_at timestamptz,
  add column managed_failed_invoice_id text;

-- ---------------------------------------------------------------------------
-- pg_net cannot read process env, so the threshold cron reads its target URL +
-- bearer secret from the DB, same as the worker-wake config. The app route this
-- points at is the internal managed-threshold endpoint (NOT the worker). Seeded
-- via ops, kept out of git; null/'' makes the sweep inert (tests drive the route
-- directly).
alter table public.worker_config
  add column managed_threshold_url    text,
  add column managed_threshold_secret text;

-- ---------------------------------------------------------------------------
-- The invoice projection: one row per (org, period, provider, model). NOT the
-- source of truth (managed_spend_ledger is) and NOT append-only — a derived,
-- idempotently-recomputed snapshot.
--
--   accrued_usd   ledger truth: Σ amount_usd of accrue rows for this grain
--                 (already markup-inclusive — the worker priced it that way).
--   invoiced_usd  the part already on a FINALIZED Stripe invoice. The live
--                 invoice covers exactly accrued_usd − invoiced_usd, so accrual
--                 continues correctly across each invoice boundary.
--   dirty         accrued_usd changed since the last Stripe push.
create table public.managed_invoice_lines (
  org_id                 uuid not null references public.organizations(id) on delete cascade,
  period_start           timestamptz not null,
  period_end             timestamptz not null,
  provider               text not null,
  model                  text not null,
  accrued_usd            numeric(14, 6) not null default 0 check (accrued_usd >= 0),
  invoiced_usd           numeric(14, 6) not null default 0 check (invoiced_usd >= 0),
  -- Markup snapshot for display/audit; the dollar amounts already include it.
  unit_markup_pct        numeric(6, 3),
  stripe_invoice_item_id text,
  stripe_invoice_id      text,
  dirty                  boolean not null default true,
  updated_at             timestamptz not null default now(),
  primary key (org_id, period_start, provider, model)
);

create index managed_invoice_lines_uninvoiced_idx
  on public.managed_invoice_lines (org_id, period_start)
  where (accrued_usd > invoiced_usd);

alter table public.managed_invoice_lines enable row level security;
revoke all on public.managed_invoice_lines from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Recompute ALL of a period's invoice lines from the ledger in one statement —
-- the authoritative reconciler (the accrue path maintains lines incrementally;
-- this is the belt-and-suspenders recompute for catch-up / reconciliation).
-- accrued_usd tracks the ledger both ways; a change re-marks the line dirty.
create or replace function public.refresh_managed_invoice_lines(
  p_org_id uuid,
  p_period_start timestamptz
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into managed_invoice_lines
    (org_id, period_start, period_end, provider, model, accrued_usd, unit_markup_pct, dirty)
  select
    org_id, period_start, max(period_end), provider, model,
    sum(amount_usd), max(markup_pct), true
  from managed_spend_ledger
  where org_id = p_org_id
    and period_start = p_period_start
    and entry_type = 'accrue'
    and provider is not null
    and model is not null
  group by org_id, period_start, provider, model
  on conflict (org_id, period_start, provider, model) do update
    set accrued_usd     = excluded.accrued_usd,
        unit_markup_pct = excluded.unit_markup_pct,
        dirty           = managed_invoice_lines.dirty
                          or managed_invoice_lines.accrued_usd is distinct from excluded.accrued_usd,
        updated_at      = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- A period's un-invoiced accrued managed spend (Σ accrued − invoiced). The
-- credit currently extended for the period — what the threshold bounds.
create or replace function public.managed_uninvoiced_total(
  p_org_id uuid,
  p_period_start timestamptz
) returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(accrued_usd - invoiced_usd), 0)
  from managed_invoice_lines
  where org_id = p_org_id and period_start = p_period_start;
$$;

-- ---------------------------------------------------------------------------
-- Re-create the S8 accrue function (20260613000001) with the SAME body plus an
-- incremental upsert into managed_invoice_lines, so the invoice mirror stays
-- current on every managed call without a per-tick full recompute. Adding this
-- run's cost to the line is exactly equal to re-summing the accrue rows (the
-- ledger is append-only), so the incremental path and refresh_managed_invoice_lines
-- never disagree. Lines are only maintained when provider+model are present
-- (always true for a real accrue; the PK columns are NOT NULL).
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

  -- Keep the invoice mirror current (#186). Incremental add equals re-summing
  -- the immutable accrue rows; re-marks the line dirty for the next push.
  if p_provider is not null and p_model is not null then
    insert into managed_invoice_lines
      (org_id, period_start, period_end, provider, model, accrued_usd, unit_markup_pct, dirty)
    values
      (p_org_id, v_ps, v_pe, p_provider, p_model, p_amount_usd, p_markup_pct, true)
    on conflict (org_id, period_start, provider, model) do update
      set accrued_usd     = managed_invoice_lines.accrued_usd + excluded.accrued_usd,
          unit_markup_pct = excluded.unit_markup_pct,
          dirty           = true,
          updated_at      = now();
  end if;

  return public.managed_spend_total(p_org_id, v_ps);
end;
$$;

-- ---------------------------------------------------------------------------
-- Advance a line's invoiced watermark after a Stripe invoice for it finalized.
-- Atomic add (concurrent accrual may have grown accrued_usd meanwhile), and
-- dirty is recomputed: it stays dirty iff there is STILL un-invoiced spend (more
-- arrived during the push), so the next sweep bills the remainder. SET sees the
-- pre-update row, so `invoiced_usd + p_amount` is the new watermark.
create or replace function public.mark_managed_line_invoiced(
  p_org_id uuid,
  p_period_start timestamptz,
  p_provider text,
  p_model text,
  p_amount numeric,
  p_invoice_id text,
  p_item_id text
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update managed_invoice_lines
  set invoiced_usd           = invoiced_usd + p_amount,
      stripe_invoice_id      = p_invoice_id,
      stripe_invoice_item_id = p_item_id,
      dirty                  = accrued_usd > invoiced_usd + p_amount,
      updated_at             = now()
  where org_id = p_org_id
    and period_start = p_period_start
    and provider = p_provider
    and model = p_model;
$$;

-- ---------------------------------------------------------------------------
-- The once-a-minute sweep. Pokes the app route when any Team carries un-invoiced
-- managed spend; the route does the authoritative, code-side threshold decision
-- (plan constants live in code, ADR-0008 — the DB stays "dumb"). Mirrors
-- tick_schedules: net.http_post to a configured URL with a bearer secret, only
-- when there is work. Returns the candidate count.
create or replace function public.tick_managed_threshold()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp, net
as $$
declare
  v_count integer;
  v_cfg   record;
begin
  select count(distinct org_id) into v_count
  from managed_invoice_lines
  where accrued_usd > invoiced_usd;

  if v_count > 0 then
    select managed_threshold_url, managed_threshold_secret into v_cfg
    from worker_config where id = 1;
    if v_cfg.managed_threshold_url is not null and v_cfg.managed_threshold_url <> '' then
      perform net.http_post(
        url     => v_cfg.managed_threshold_url,
        body    => '{}'::jsonb,
        headers => case
          when coalesce(v_cfg.managed_threshold_secret, '') <> '' then
            jsonb_build_object('Content-Type', 'application/json',
                               'Authorization', 'Bearer ' || v_cfg.managed_threshold_secret)
          else '{"Content-Type":"application/json"}'::jsonb
        end
      );
    end if;
  end if;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Service-role only for the helpers (server + worker run as service_role). The
-- accrue grant is re-applied because create-or-replace keeps existing grants,
-- but re-stating it is harmless and keeps the migration self-describing.
revoke execute on function public.refresh_managed_invoice_lines(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.managed_uninvoiced_total(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.mark_managed_line_invoiced(uuid, timestamptz, text, text, numeric, text, text) from public, anon, authenticated;
revoke execute on function public.tick_managed_threshold() from public, anon, authenticated;
grant  execute on function public.refresh_managed_invoice_lines(uuid, timestamptz) to service_role;
grant  execute on function public.managed_uninvoiced_total(uuid, timestamptz) to service_role;
grant  execute on function public.mark_managed_line_invoiced(uuid, timestamptz, text, text, numeric, text, text) to service_role;
grant  execute on function public.tick_managed_threshold() to service_role;

-- Register the once-a-minute tick (idempotent across db resets).
do $$
begin
  perform cron.unschedule('tick-managed-threshold');
exception when others then
  null;
end
$$;

select cron.schedule('tick-managed-threshold', '* * * * *', $$ select public.tick_managed_threshold(); $$);
