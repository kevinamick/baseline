create type public.evaluation_mode as enum ('conversational', 'prompt_response');

create table public.rubrics (
  id                   uuid primary key default gen_random_uuid(),
  created_by           text not null references public.users(id) on delete cascade,
  -- org_id will be added in a future migration when teams are implemented
  name                 text not null,
  scenario_description text not null,
  expected_outcome     text not null,
  evaluation_mode      public.evaluation_mode not null,
  grounding_context    text,
  criteria             jsonb not null default '[]'::jsonb check (jsonb_typeof(criteria) = 'array'),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index rubrics_created_by_created_at_idx on public.rubrics(created_by, created_at desc);

alter table public.rubrics enable row level security;
