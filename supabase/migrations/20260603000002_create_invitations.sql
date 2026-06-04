-- Organization invitations (#50). Replaces the invite portion of Clerk's
-- <OrganizationProfile/>: an admin invites a person by email, a pending
-- invitation is created, and the invitee accepts to receive a membership.
--
-- We roll our own (rather than Supabase's inviteUserByEmail) so org/role
-- semantics stay in our schema and the flow is provider-independent. The token
-- is single-use (stamp accepted_at) and time-boxed (expires_at). Only the
-- sha256 hash of the token is stored; the raw token rides only in the emailed
-- accept URL, so a DB leak can't be replayed.
create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  email       text not null,
  role        text not null default 'member' check (role in ('admin', 'member')),
  token_hash  text not null unique,
  invited_by  uuid references public.users(id) on delete set null,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);

-- Listing pending invites for a team's settings page.
create index invitations_org_id_idx on public.invitations(org_id);

-- At most one live (unaccepted) invite per (org, email); a revoke deletes the
-- row, and an accept stamps accepted_at, so re-inviting afterwards is allowed.
create unique index invitations_pending_unique
  on public.invitations(org_id, email)
  where accepted_at is null;

-- Deny-all + service-role bypass (house pattern); all access is via the app's
-- service-role client, scoped by org_id in code.
alter table public.invitations enable row level security;
