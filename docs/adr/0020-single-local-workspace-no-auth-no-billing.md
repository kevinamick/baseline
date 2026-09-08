# A single Local Workspace replaces sign-in, Teams, and billing

Baseline is becoming an open-source, self-hosted tool and the hosted SaaS is retiring.
Anyone who clones the repository must reach a working app with no account, no sign-in,
and no card. So the app has exactly one implicit **Workspace**: whoever reaches the
running app is its sole Contributor. There are no users, no roles, no Invitations, no
Access Codes, no Plans, no Eval Points, no Managed Key, and no Stripe. LLM calls run on
the operator's own provider keys, supplied through the worker environment or pasted into
Settings, and nothing meters or caps them.

The gates are removed rather than switched off. A self-hosted mode flag would keep the
SaaS code paths compiling and tested behind a switch nobody deploys, and every future
change would have to reason about two products. With the hosted product gone there is
no second product to protect, so the code that only existed to run it goes with it.

## Status

Accepted.

## Considered options

**A self-hosted mode switch (rejected).** One env var makes the proxy skip the session
gate, the auth seam return a fixed identity, and billing resolve to an uncapped plan.
Reversible and cheap, and the right shape while a hosted product still ships from the
same repo. Rejected because the SaaS is retiring: the switch would freeze two code paths
and a double test matrix into an open-source codebase whose readers only ever run one.

**Keep Supabase Auth as optional multi-user login (rejected for now).** Useful for a
shared self-host, but it keeps GoTrue, memberships, roles, and the invitation flow alive
for a use case nobody has asked for yet. A later contributor can add authentication in
front of the single Workspace; nothing here prevents it.

**Rewrite the schema without `org_id` (rejected).** Every tenant table carries an
`org_id` and every read goes through `tenantDb`. Dropping the column from thirty tables
and every query buys nothing the operator can see. The `organizations` table keeps one
fixed row, the Workspace, and `org_id` keeps pointing at it.

## Consequences

- **Identity.** `getAuthContext()` returns the Local Workspace unconditionally: a fixed
  user id, the fixed Workspace id, and write access. The proxy no longer gates any route
  and no longer refreshes a Supabase session. The sign-in, sign-up, password, onboarding,
  invitation, and OAuth routes, actions, emails, and tests are deleted. The `memberships`,
  `invitations`, `access_codes`, `access_code_redemptions`, and `signup_passes` tables and
  the GoTrue `before_user_created` hook are dropped. `public.users` keeps one fixed row so
  the `created_by` columns stay valid without a schema rewrite.
- **Billing.** Stripe, the Plan table, the Point Ledger, managed-spend metering, overage,
  retention windows, seat caps, trust tiers, the billing settings page, the pricing page,
  and the internal billing cron routes are deleted along with their tables and SQL
  functions. The rubric editor and the optimization wizard lose their plan caps. An
  Optimization Run's budget is bounded only by the operator's own limits.
- **Provider keys.** The worker reads keys from its environment (for example
  `ANTHROPIC_API_KEY`), and a key pasted into Settings overrides the environment for
  that provider. There is no managed fallback and nothing is metered. A run with no key
  for its provider still fails closed with copy naming the missing key.
- **Vocabulary.** CONTEXT.md drops the Access & Membership and Billing sections. "Team"
  becomes "Workspace" everywhere a reader can see it; the singular, implicit Workspace
  owns every Rubric, Connection, Schedule, and run.
- **Getting started.** One `docker compose up` brings up Postgres with the Supabase
  extensions, PostgREST, Temporal, the worker, and the app. The SaaS deployment
  machinery (Vercel, Fly, prod migrations, auth email push) leaves the repository.
- **Data already in the retiring databases** is not migrated. The drop migrations run
  against a fresh local database; the hosted projects are decommissioned, not upgraded.
