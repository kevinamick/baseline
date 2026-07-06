# Access Codes gate account creation and delegate benefits to Stripe

Baseline's launch phase is invite-only: an **Access Code** (see CONTEXT.md — distinct
from the team-member **Invitation**) is the only way to create an account without a
pending Invitation, and a code may carry a billing benefit (trial and/or discount).
The gate is temporary; the benefit machinery is permanent. Several placements and
mechanisms were genuinely contested, so the shape is recorded here.

**Decision.** The gate sits on **account creation** — the `signUp` server action
requires a valid Access Code or a pending Invitation matching the email — even though
the billing subject is the Team (ADR-0007) and gating `createOrganization` would have
been a smaller enforcement surface (one action, no OAuth exposure, redemption already
Team-shaped). We chose the account gate deliberately: a user who can sign up but
cannot create a Team is stuck in limbo, and "you may not enter" must be said at the
front door, not one screen in. The costs of that placement are accepted and handled:

- **OAuth stays disabled while gated.** OAuth creates the Supabase user during the
  token exchange, before app code can demand anything. Rather than wire the
  `before_user_created` auth hook (which has no channel to carry a code on the OAuth
  leg) or delete just-created users in the callback, we simply don't enable OAuth
  until the gate lifts. It is already disabled in committed config.
- **Redemptions claim at submit, atomically.** `supabase.auth.signUp` creates the
  (unconfirmed) user at submit, so the cap check and the count-increment are one
  atomic claim at that moment (`UPDATE … WHERE redemptions < max_redemptions`),
  released only if user creation itself fails. Counting at email confirmation instead
  would make the cap advisory exactly when a code goes viral — an over-admitting cap
  is a broken cap; a slot lost to an abandoned sign-up is a shrug (raise the cap).
- **The user→Team hand-off is explicit.** A redemption's benefit binds to the first
  Team its redeemer creates and is evaluated exactly once, at that Team's first
  checkout; it never transfers to an existing Team (an employee's personal code must
  not discount their employer's subscription) and never floats between Teams.

**Benefits are Stripe primitives, not an in-house discount engine.** A code carries
two nullable grant fields: `trial_days` (applied as
`subscription_data.trial_period_days` at first checkout) and `stripe_coupon_id`
(applied via `discounts`). Baseline stores references and performs no percent math,
duration bookkeeping, or proration; the invoice line is Stripe-native, preserving
ADR-0008's mirror discipline. A code may be restricted to a single Plan; the
restriction limits the **benefit**, never the purchase — checkout on a mismatched
plan proceeds at full price after an explicit notice (we will not block someone from
buying the more expensive plan because their coupon was for the cheaper one).

**Trials collect a card.** `trialing` grants full paid access including the Managed
Key, so a card-free trial would recreate the exposure ADR-0008's Free wall exists to
prevent (metered token spend with nothing to bill). Checkout keeps Stripe's default
card collection; the invariant "paid access always has a billable card behind it"
stays airtight and code-granted trials require zero changes to billing internals.

**The gate lever is a PostHog feature flag, failing closed.** `signup-access-code-gate`
is evaluated server-side (anonymous distinctId) in both the sign-up page and the
`signUp` action, mirroring the worker's kill-switch helper: PostHog unconfigured
(dev/CI/e2e) → ungated; readable → the flag decides; evaluation failure → **gated**,
the opposite failure direction from the worker's merge flag, because a PostHog blip
must never silently un-gate registration (coded and invited users don't depend on the
flag, so they still get through during an outage). The flag is a transition lever,
not permanent config: when the gate is retired for good, the check and the flag are
deleted — left in place, the fail-closed rule would re-gate sign-up during any future
PostHog outage.

**Rejected alternatives worth remembering.**
- *Gate Team creation instead* — smaller surface, free Invitation bypass, phase-2
  no-op; rejected for the limbo-account experience.
- *Own discount model* — rejected; recreates a solved problem and pollutes the
  Stripe mirror discipline.
- *Env-var gate lever* — honest and simple, but the flag buys no-deploy flips and
  cohort rollout on infrastructure that already exists worker-side.
- *Card-free trials* — rejected until there's evidence the friction matters; would
  require a new key-gate state to wall trialing-without-card off the Managed Key.

**Consequences.**
- Codes are shareable plaintext identifiers (matched case-insensitively), not
  hashed secrets like Invitation tokens: guessing one admits a sign-up, not a
  takeover, and the per-IP rate limiter (ADR-0010) plus `max_redemptions` bound the
  abuse. Minting is script-only; the Stripe Dashboard is the coupon UI — no
  platform-admin surface is introduced for this.
- Redemptions live in their own table (code, redeemer, later-stamped Team,
  consumed-at-checkout state) so campaign attribution and the one-shot binding have
  a home; `max_redemptions` is a column, not a code-per-seat spreadsheet.
- On lift day the delta is: flag off (code field becomes optional but still
  redeems), OAuth enabled, outstanding gate-pass-only codes become harmless no-ops.
  The redemption/grant model does not change shape — that was the point of binding
  benefits to Teams and checkout from day one.
