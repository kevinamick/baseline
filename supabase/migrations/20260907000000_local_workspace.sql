-- The Local Workspace (ADR-0020): Baseline runs as one implicit Workspace with no
-- sign-in, no membership, and no invitation. This migration seeds that Workspace
-- and removes everything that only existed to gate account creation and Team
-- membership: Supabase Auth's user mirror trigger, memberships (and its last-admin
-- guard), invitations, access codes + redemptions, signup passes + the GoTrue
-- before_user_created hook, and the auth-surface rate limiter.
--
-- `public.users` stays (one fixed row) so the `created_by` columns keep their
-- foreign keys without a schema rewrite; `organizations` stays (one fixed row) so
-- every tenant table's `org_id` keeps pointing at the Workspace.

-- ---------------------------------------------------------------------------
-- 1. Seed the Workspace + its Contributor. Ids match src/lib/auth/local-workspace.ts.
-- ---------------------------------------------------------------------------
insert into public.users (id)
values ('00000000-0000-4000-8000-000000000002')
on conflict (id) do nothing;

insert into public.organizations (id, name)
values ('00000000-0000-4000-8000-000000000001', 'Local Workspace')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Supabase Auth is no longer the identity source.
-- ---------------------------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

drop function if exists public.before_user_created_hook(jsonb);
drop table if exists public.signup_passes;

-- ---------------------------------------------------------------------------
-- 3. Membership, invitations, and access codes.
-- ---------------------------------------------------------------------------
drop trigger if exists memberships_min_one_admin on public.memberships;
drop function if exists public.enforce_min_one_admin();
drop table if exists public.memberships;

drop table if exists public.invitations;

drop function if exists public.claim_access_code(text);
drop function if exists public.release_access_code_claim(uuid);
drop table if exists public.access_code_redemptions;
drop table if exists public.access_codes;

-- ---------------------------------------------------------------------------
-- 4. The auth-surface rate limiter (ADR-0010) guarded sign-in/sign-up/invite
--    flows that no longer exist.
-- ---------------------------------------------------------------------------
select cron.unschedule(jobid)
  from cron.job
 where command like '%rate_limit_hits%';
drop function if exists public.increment_rate_limit(text, timestamptz, text, text);
drop table if exists public.rate_limit_hits;
