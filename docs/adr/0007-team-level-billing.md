# Teams, not users, are the billing subject

Subscriptions, plans, quotas, and usage all attach to the Team (an `organizations` row), not to an individual user. One Stripe customer and at most one subscription per Team; checkout passes the `org_id` (not the user id) as `client_reference_id`, and the `customers` table is re-keyed from `user_id` to `org_id`.

The alternative — user-level billing, which the early checkout scaffolding implemented — breaks down against the rest of the model: every consumable (Eval Runs, Optimization Runs) already belongs to a Team, seat counts are a plan dimension ("1 User Seat" on Free vs unlimited on paid), and a user can belong to multiple Teams (since #52), making "whose subscription covers this run?" ambiguous. With Team-level billing each Team has exactly one plan, quota enforcement keys off `org_id` directly, and the Free plan's seat limit becomes a membership cap on free Teams.

We migrate now, while the user-keyed `customers` table is scaffolding with no real subscribers behind it — reversing this after launch would mean migrating live Stripe customers.

## Consequences

- The pricing model (issue #137) is enforced per Team: included Eval Points, included Optimization Runs, seat limits, and data retention are all Team-scoped.
- A user on several Teams may encounter different plan limits in each; nothing about their personal account carries a plan.
- The existing user-level checkout flow and `customers` schema are reworked before any further billing work builds on them.
