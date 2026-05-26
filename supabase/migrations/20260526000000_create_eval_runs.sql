create extension if not exists pgmq;

select pgmq.create('eval_runs');

create type public.eval_run_status as enum ('queued', 'running', 'completed', 'failed');

create table public.eval_runs (
  id                  uuid primary key default gen_random_uuid(),
  created_by          text not null references public.users(id) on delete cascade,
  rubric_id           uuid not null references public.rubrics(id) on delete cascade,
  status              public.eval_run_status not null default 'queued',
  eval_type           text not null default 'tabular',
  description         text,
  notification_emails text[],
  overall_score       numeric(4,3),
  error_message       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table public.eval_run_rows (
  id                uuid primary key default gen_random_uuid(),
  eval_run_id       uuid not null references public.eval_runs(id) on delete cascade,
  row_index         integer not null,
  user_input        text not null,
  agent_output      text not null,
  expected_output   text,
  retrieval_context text
);

create table public.eval_run_results (
  id             uuid primary key default gen_random_uuid(),
  eval_run_id    uuid not null references public.eval_runs(id) on delete cascade,
  row_index      integer not null,
  criterion_name text not null,
  score          numeric(4,3) not null,
  reasoning      text not null
);

create index eval_runs_rubric_idx        on public.eval_runs(rubric_id, created_at desc);
create index eval_run_rows_run_idx       on public.eval_run_rows(eval_run_id, row_index);
create index eval_run_results_run_idx   on public.eval_run_results(eval_run_id, row_index);

alter table public.eval_runs        enable row level security;
alter table public.eval_run_rows    enable row level security;
alter table public.eval_run_results enable row level security;

-- Wrapper called by the server action to enqueue a run
create or replace function public.enqueue_eval_run(run_id uuid)
returns void
language sql
security definer
as $$
  select pgmq.send('eval_runs', jsonb_build_object('runId', run_id::text));
$$;

-- Wrapper called by the worker to dequeue one message (visibility timeout = 60s)
create or replace function public.dequeue_eval_run_message(vt_seconds int default 60)
returns table(msg_id bigint, run_id uuid)
language sql
security definer
as $$
  select m.msg_id, (m.message->>'runId')::uuid as run_id
  from pgmq.read('eval_runs', vt_seconds, 1) m;
$$;

-- Wrapper called by the worker to acknowledge (delete) a processed message
create or replace function public.ack_eval_run_message(p_msg_id bigint)
returns void
language sql
security definer
as $$
  select pgmq.delete('eval_runs', p_msg_id);
$$;
