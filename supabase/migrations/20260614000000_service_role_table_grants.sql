-- Grant the Data API roles explicit access, per Supabase's "Tables not exposed to
-- Data and GraphQL API automatically" breaking change (changelog #45329):
--   opt-in 2026-04-28 · default for new projects 2026-05-30 · enforced everywhere 2026-10-30.
-- https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically
--
-- Before this change, every table in `public` was auto-granted to anon/authenticated/
-- service_role on creation (gated only by RLS). Our migrations relied on that implicit
-- grant and never granted tables themselves. The newer Supabase CLI ships the new
-- behavior, so `supabase start` in CI produced a service_role with no table privileges
-- → "permission denied for table organizations" in the e2e seed. Pinning the CLI to a
-- pre-change version papered over it; granting explicitly removes the version dependency.
--
-- Scope is service_role ONLY, and this is the *correct* scope, not a shortcut:
--   * service_role is a server-only secret that bypasses RLS. The app does ALL table I/O
--     through it (src/lib/supabase/admin.ts), with authz enforced in app code
--     (src/lib/auth/getAuthContext). The e2e seed uses it too.
--   * anon/authenticated only ever call auth.getUser() — they touch no public tables. All
--     27 app tables enable RLS with no policy, which denies them by design. So they need
--     no grant, and under the new least-privilege model they should have none.
-- Supabase recommends explicit CRUD verbs over `grant all`, so we grant exactly the four.

-- Existing tables + sequences (bulk remediation form from the Supabase changelog).
grant select, insert, update, delete on all tables    in schema public to service_role;
grant usage, select                  on all sequences in schema public to service_role;

-- Future tables + sequences: keep service_role auto-granted so a later table migration
-- that forgets its grant doesn't silently break the server again. Limited to service_role
-- (server-only, RLS-bypassing), so this carries no Data API exposure for anon/authenticated.
alter default privileges in schema public grant select, insert, update, delete on tables    to service_role;
alter default privileges in schema public grant usage, select                  on sequences to service_role;
