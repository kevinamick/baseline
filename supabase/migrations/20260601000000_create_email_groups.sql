-- Named lists of notification recipients owned by a team.
-- Groups are assigned to eval runs and schedules to auto-populate recipients.

create table public.email_groups (
  id          uuid primary key default gen_random_uuid(),
  org_id      text not null references public.organizations(id) on delete cascade,
  created_by  text not null references public.users(id) on delete cascade,
  name        text not null,
  emails      text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index email_groups_org_id_idx on public.email_groups(org_id, created_at desc);

alter table public.email_groups enable row level security;
