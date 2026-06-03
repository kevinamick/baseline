-- Orgs slice (#47): give the app its own multi-tenancy. Supabase Auth has no
-- organization primitive, so organizations + memberships live in our tables and
-- roles are sourced from membership (replacing Clerk's org/orgRole claims).
--
-- Greenfield (reset, no backfill): local + staging are reset, so the text->uuid
-- conversions below run against empty tables. Identifiers move from Clerk's text
-- ids (`org_…`, `user_…`) to native uuids:
--   * organizations.id  text -> uuid (default gen_random_uuid())
--   * users.id          text -> uuid, now FK'd to auth.users(id) (was unconstrained)
--   * every org_id / *_created_by FK column repointed to the uuid tables
--
-- This is the conversion #46's handle_new_user migration deferred here.

-- 1. Drop the FKs that reference users.id / organizations.id (and the columns
--    being retyped) so the parent PK types can change. Recreated in step 4.
alter table public.customers   drop constraint if exists customers_clerk_user_id_fkey;
alter table public.rubrics     drop constraint if exists rubrics_created_by_fkey;
alter table public.rubrics     drop constraint if exists rubrics_org_id_fkey;
alter table public.eval_runs   drop constraint if exists eval_runs_created_by_fkey;
alter table public.connections drop constraint if exists connections_created_by_fkey;
alter table public.connections drop constraint if exists connections_org_id_fkey;
alter table public.schedules   drop constraint if exists schedules_created_by_fkey;
alter table public.schedules   drop constraint if exists schedules_org_id_fkey;

-- 2. Retype the parent PKs.
alter table public.users
  alter column id type uuid using id::uuid;

alter table public.organizations
  alter column id type uuid using id::uuid,
  alter column id set default gen_random_uuid();

-- The team's display name. Clerk owned this before; onboarding now sets it.
alter table public.organizations
  add column name text not null;

-- 3. Retype the child FK columns.
--    customers.clerk_user_id keeps its name here (the rename to user_id + the
--    Stripe checkout rewire belong to #49); only its type changes so the FK to
--    the now-uuid users.id stays valid.
alter table public.customers
  alter column clerk_user_id type uuid using clerk_user_id::uuid;

alter table public.rubrics
  alter column created_by type uuid using created_by::uuid,
  alter column org_id     type uuid using org_id::uuid;

alter table public.eval_runs
  alter column created_by type uuid using created_by::uuid;

alter table public.connections
  alter column org_id     type uuid using org_id::uuid,
  alter column created_by type uuid using created_by::uuid;

alter table public.schedules
  alter column org_id     type uuid using org_id::uuid,
  alter column created_by type uuid using created_by::uuid;

-- 4. users.id now mirrors auth.users(id); a deleted auth user cascades away.
--    Recreate the child FKs against the uuid tables.
alter table public.users
  add constraint users_id_fkey
  foreign key (id) references auth.users(id) on delete cascade;

alter table public.customers
  add constraint customers_clerk_user_id_fkey
  foreign key (clerk_user_id) references public.users(id) on delete cascade;

alter table public.rubrics
  add constraint rubrics_created_by_fkey
  foreign key (created_by) references public.users(id) on delete cascade,
  add constraint rubrics_org_id_fkey
  foreign key (org_id) references public.organizations(id) on delete cascade;

alter table public.eval_runs
  add constraint eval_runs_created_by_fkey
  foreign key (created_by) references public.users(id) on delete cascade;

alter table public.connections
  add constraint connections_created_by_fkey
  foreign key (created_by) references public.users(id) on delete cascade,
  add constraint connections_org_id_fkey
  foreign key (org_id) references public.organizations(id) on delete cascade;

alter table public.schedules
  add constraint schedules_created_by_fkey
  foreign key (created_by) references public.users(id) on delete cascade,
  add constraint schedules_org_id_fkey
  foreign key (org_id) references public.organizations(id) on delete cascade;

-- 5. Membership is the join between a user and an organization, and the source
--    of truth for role. Single-owner today: onboarding creates one org with one
--    `admin` membership. `member` (read-only) arrives with invitations (#50).
create table public.memberships (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  role       text not null check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- Single-owner today: a user belongs to exactly one organization, so getAuthContext
-- can treat the membership as unique. This constraint enforces that invariant (and
-- makes the onboarding insert safe under concurrent submits); its unique index also
-- serves the by-user_id lookup, which the (org_id, …) PK can't. #52 (multi-org
-- membership + active-org switching) drops it.
alter table public.memberships
  add constraint memberships_user_id_key unique (user_id);

alter table public.memberships enable row level security;

-- 6. users.id is uuid now, so handle_new_user can insert the auth uuid directly
--    (the ::text cast from #46 is gone). Re-created here rather than editing the
--    prior migration, keeping migrations append-only.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;
