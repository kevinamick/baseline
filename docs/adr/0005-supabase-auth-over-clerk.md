# Replace Clerk with Supabase Auth

To support fully local, detached development, we are replacing Clerk with Supabase Auth as the authentication provider. Clerk's development instance is cloud-only and shared with staging, so locally-created users and organizations live on Clerk's servers and must be mirrored into Supabase via webhooks — forcing a manual `seed.sql` to satisfy FK constraints and preventing offline/detached work. Supabase already runs in the local CLI stack, so moving auth there lets the whole app run against local infrastructure with no external auth dependency.

The trade-off: Clerk provided hosted organizations, invitations, member management, and an account portal out of the box. Supabase Auth has no organization primitive, so we rebuild multi-tenancy in our own tables (`organizations` + `memberships`, superseding [ADR-0002](./0002-teams-as-clerk-organizations.md)) and reproduce the parity features (invitations, member management, multi-org switching, account/password management, social login) as follow-up slices.

Identity reads stay behind the `getAuthContext()` seam, so the provider is isolated to one module. The first slice (#46) swaps the auth backend only — email/password sign-in/up, session refresh in `proxy.ts`, and a `handle_new_user` trigger that mirrors `auth.users` into `public.users` — while orgs/roles remain stubbed; the org/role model migrates in #47.

## Consequences

- New users get native Supabase `auth.users` UUID ids. This is greenfield (local + staging reset, no backfill).
- ADR-0002 (Teams are backed by Clerk Organizations) is superseded: Teams become `organizations` + `memberships` rows in #47.
- The Clerk webhook, the `@clerk/nextjs` dependency, and Clerk env vars are removed in the final cutover (#56).
