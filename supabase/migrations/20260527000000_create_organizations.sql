-- Organizations are owned by Clerk; this table is a FK anchor only.
-- Populated via the organization.created / organization.deleted Clerk webhooks.
create table public.organizations (
  id         text primary key,
  created_at timestamptz not null default now()
);

alter table public.organizations enable row level security;

-- Clear any existing dev rubrics/eval_runs that have no org_id before adding the NOT NULL column.
truncate table public.eval_run_results, public.eval_run_rows, public.eval_runs, public.rubrics restart identity cascade;

alter table public.rubrics
  add column org_id text not null references public.organizations(id) on delete cascade;

drop index if exists rubrics_created_by_created_at_idx;
create index rubrics_org_id_created_at_idx on public.rubrics(org_id, created_at desc);
