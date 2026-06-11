-- Billing S1 (#178, ADR-0007): Teams, not users, are the billing subject.
--
-- The customers table was scaffolded user-keyed (#49). Re-key it to the Team
-- (organizations) so there is one Stripe customer + one subscription per Team,
-- and widen it into a *mirror* of Stripe subscription state — the app reads
-- billing state from here, never from the live Stripe API (ADR-0008).
--
-- Greenfield: local + staging reset, no real subscribers behind the user-keyed
-- rows, so we drop and recreate rather than backfill org_ids we don't have.

drop table if exists public.customers;

create table public.customers (
  -- One row per Team. The Team is the billing subject (ADR-0007).
  org_id                 uuid primary key
    references public.organizations(id) on delete cascade,
  stripe_customer_id     text unique not null,
  stripe_subscription_id text,

  -- Mirror of Stripe subscription state, kept fresh by the webhook. Reads never
  -- call Stripe; the fail-closed resolver (lib/billing) derives access from these.
  -- status is the raw Stripe subscription status (active, trialing, past_due,
  -- canceled, unpaid, incomplete, incomplete_expired); null until first synced.
  status                 text,
  -- The subscribed price. Its mapping to a plan slug lands in #179; until then
  -- the price id *is* the plan identity.
  stripe_price_id        text,
  current_period_start   timestamptz,
  current_period_end     timestamptz,

  -- The `created` time of the last status-bearing event applied to this row.
  -- Stripe delivers webhooks out of order, so a stale event (older `created`)
  -- must not clobber newer state — e.g. a late subscription.updated must never
  -- un-cancel a canceled Team. Null until the first status event lands.
  mirror_event_at        timestamptz,

  email                  text,
  updated_at             timestamptz not null default now()
);

create index customers_subscription_id_idx
  on public.customers(stripe_subscription_id);

-- Service-role only (the admin client mirrors webhooks; reads go through the
-- billing resolver). No anon/auth policies — RLS on with no policy denies all.
alter table public.customers enable row level security;

-- Idempotency ledger: Stripe redelivers events (at-least-once), and the endpoint
-- is reachable by any POST. Recording each processed event id lets a replay be
-- recognised and acknowledged without re-applying side effects (ADR-0008's
-- "no duplicate records, no state corruption"). The primary key does the dedupe;
-- an insert that conflicts means "already handled".
create table public.billing_events (
  stripe_event_id text primary key,
  type            text not null,
  processed_at    timestamptz not null default now()
);

alter table public.billing_events enable row level security;
