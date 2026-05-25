create table public.users (
  id          text primary key,
  created_at  timestamptz not null default now()
);

alter table public.users enable row level security;
