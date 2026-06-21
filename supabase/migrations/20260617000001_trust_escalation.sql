-- Trust escalation for the Managed Spend Cap (#188, ADR-0008's fourth managed-token
-- guardrail).
--
-- A Team's *trust ceiling* — the highest its Managed Spend Cap may be self-raised
-- to — starts at the plan default and rises with paid-invoice history. The
-- escalation schedule (count of clean invoices → multiple of the plan default)
-- is a pricing knob in code (PLANS / TRUST_ESCALATION_SCHEDULE), so the SQL stays
-- "dumb": it only records the raw history. The app derives the ceiling and blocks
-- raises above it (billing-managed-spend.ts).
--
-- This table is the *history mirror*: one row per Stripe invoice we've seen paid,
-- with a nullable reversal stamp. Only un-reversed rows count toward trust — a
-- refunded, disputed, voided, or uncollectible invoice never advances the
-- ceiling (a chargeback artist can't buy trust). The webhook writes here; like
-- customers/billing_settings the writes go through the service-role admin client,
-- which bypasses RLS, so the table needs no SECURITY DEFINER RPCs.

create table public.paid_invoices (
  -- The Stripe invoice id is globally unique, so it alone keys the row; reversal
  -- events (charge.refunded / dispute / uncollectible) carry only the invoice or
  -- charge, never our org_id, so keying on it lets them stamp by id alone.
  stripe_invoice_id text primary key,
  -- The Team this invoice belongs to — trust is per-Team, never pooled across
  -- Teams (a sibling Team's history must never advance this one's ceiling).
  org_id            uuid not null references public.organizations(id) on delete cascade,
  -- When Stripe reported the invoice paid (event time), and the amount, for audit.
  paid_at           timestamptz not null,
  amount_usd        numeric(14, 2) not null default 0 check (amount_usd >= 0),
  -- The PaymentIntent that settled this invoice, captured at record time. A
  -- refund (charge.refunded) and a dispute (charge.dispute.created) name only a
  -- charge / payment intent, never our invoice id, so this is how those reversals
  -- find the row to stamp. Null when Stripe surfaced no payment intent (rare; such
  -- an invoice can still be reversed by the invoice-keyed void/uncollectible events).
  stripe_payment_intent_id text,
  -- Non-null once the invoice is reversed; such a row no longer counts toward
  -- trust. reversal_reason is the cause, for the audit trail.
  reversed_at       timestamptz,
  reversal_reason   text check (
    reversal_reason is null
    or reversal_reason in ('refund', 'dispute', 'uncollectible', 'void')
  ),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- The hot path is "count un-reversed invoices for this org" (the ceiling
-- derivation); a partial index over the live rows keeps that count off the
-- reversed ones.
create index paid_invoices_org_live_idx
  on public.paid_invoices (org_id) where reversed_at is null;

-- Reversal lookups land via the payment intent (refunds / disputes).
create index paid_invoices_payment_intent_idx
  on public.paid_invoices (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- Service-role only (the webhook mirrors via the admin client; the billing
-- resolver reads through it). RLS on with no policy denies anon/authenticated;
-- the admin client bypasses RLS, matching customers / billing_settings.
alter table public.paid_invoices enable row level security;
