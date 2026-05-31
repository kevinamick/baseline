-- A Schedule is a recurring recipe that spawns Eval Runs on a cadence, evaluating
-- a Rubric against a System reached through a Connection. It is NOT itself an Eval Run.

create table public.schedules (
  id                  uuid primary key default gen_random_uuid(),
  org_id              text not null references public.organizations(id) on delete cascade,
  created_by          text not null references public.users(id) on delete cascade,
  rubric_id           uuid not null references public.rubrics(id) on delete cascade,
  connection_id       uuid not null references public.connections(id) on delete cascade,
  name                text not null,
  description         text,
  eval_type           text not null default 'tabular',
  -- cadence: frequency drives which of the fields below apply
  frequency           text not null check (frequency in ('hourly', 'daily', 'weekly', 'monthly')),
  local_hour          smallint check (local_hour between 0 and 23),  -- daily/weekly/monthly
  days_of_week        smallint[],                                    -- weekly: 1=Mon .. 7=Sun (isodow)
  day_of_month        smallint check (day_of_month between 1 and 28),-- monthly
  timezone            text not null default 'UTC',                   -- IANA tz; stores user intent (DST-safe)
  enabled             boolean not null default true,
  notification_emails text[],
  next_run_at         timestamptz,                                   -- UTC; recomputed each fire
  last_run_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index schedules_org_id_created_at_idx on public.schedules(org_id, created_at desc);
-- Fast scan for the pg_cron tick.
create index schedules_due_idx on public.schedules(next_run_at) where enabled;

alter table public.schedules enable row level security;

-- The fixed input set for an agent-kind Schedule. Mirrors eval_run_rows but WITHOUT
-- agent_output — the worker generates that live by invoking the System each tick.
create table public.schedule_inputs (
  id                uuid primary key default gen_random_uuid(),
  schedule_id       uuid not null references public.schedules(id) on delete cascade,
  row_index         integer not null,
  user_input        text not null,
  expected_output   text,
  retrieval_context text,
  constraint schedule_inputs_unique unique (schedule_id, row_index)
);

create index schedule_inputs_schedule_idx on public.schedule_inputs(schedule_id, row_index);

alter table public.schedule_inputs enable row level security;

-- Link spawned Eval Runs back to their Schedule. Manual runs leave this null.
alter table public.eval_runs
  add column schedule_id uuid references public.schedules(id) on delete set null;

create index eval_runs_schedule_idx on public.eval_runs(schedule_id, created_at desc);
