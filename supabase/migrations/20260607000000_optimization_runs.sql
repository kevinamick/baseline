-- Optimization loop (GEPA, arXiv:2507.19457), slice 2 (#87): the Optimization Run
-- aggregate and its dedicated storage. Kept separate from eval_runs so optimizer internals
-- (100-1000x the volume) never touch a Rubric's user-facing run history. Workflows carry
-- only IDs; Activities read/write these tables (ADR-0006). See CONTEXT.md.

create type public.optimization_run_status as enum ('queued', 'running', 'completed', 'failed');

create table public.optimization_runs (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  created_by        uuid not null references public.users(id) on delete cascade,
  connection_id     uuid not null references public.connections(id) on delete cascade,
  rubric_id         uuid not null references public.rubrics(id) on delete cascade,
  eval_type         text not null default 'tabular',
  -- Termination knobs (D8): rollout budget is primary; max_iters + plateau_patience are
  -- backstops. The seed slice doesn't loop yet, but the columns establish the contract.
  budget_rollouts   int not null,
  max_iters         int not null,
  plateau_patience  int,
  -- Reflection model (D7); judge stays claude-haiku. Unused until #88 adds propose().
  reflect_model     text not null default 'claude-sonnet-4-6',
  status            public.optimization_run_status not null default 'queued',
  -- FK added after optimization_candidates exists (circular reference).
  best_candidate_id uuid,
  best_score        numeric(4,3),
  workflow_id       text,
  error_message     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index optimization_runs_org_idx on public.optimization_runs(org_id, created_at desc);

-- Guardrail (D12): at most one active (queued/running) Optimization Run per org. A partial
-- unique index rejects a concurrent second start atomically at the DB — no app-level race.
create unique index optimization_runs_one_active_per_org
  on public.optimization_runs(org_id)
  where status in ('queued', 'running');

-- A Candidate is one set of prompts (one per Module) under test. Candidate 0 (generation 0)
-- holds the Connection's seed prompts; later generations descend from a parent via mutation.
create table public.optimization_candidates (
  id          uuid primary key default gen_random_uuid(),
  opt_run_id  uuid not null references public.optimization_runs(id) on delete cascade,
  parent_id   uuid references public.optimization_candidates(id) on delete set null,
  generation  int not null default 0,
  prompts     jsonb not null,            -- { <module>: text }
  created_at  timestamptz not null default now()
);

create index optimization_candidates_run_idx on public.optimization_candidates(opt_run_id, generation);

-- Now that candidates exists, point best_candidate_id at it.
alter table public.optimization_runs
  add constraint optimization_runs_best_candidate_fkey
  foreign key (best_candidate_id) references public.optimization_candidates(id) on delete set null;

-- The frozen instance set. Snapshot once at run start so every Candidate is scored on
-- identical instances (Pareto comparison requires a stable set). Mirrors schedule_inputs.
create table public.optimization_inputs (
  id                uuid primary key default gen_random_uuid(),
  opt_run_id        uuid not null references public.optimization_runs(id) on delete cascade,
  instance_index    integer not null,
  user_input        text not null,
  expected_output   text,
  retrieval_context text,
  constraint optimization_inputs_unique unique (opt_run_id, instance_index)
);

create index optimization_inputs_run_idx on public.optimization_inputs(opt_run_id, instance_index);

-- One Candidate's execution against one instance. phase separates the cheap accept/reject
-- minibatch test from the full frozen ('pareto') set. The unique key makes Activity retries
-- idempotent (Temporal may re-run an Activity).
create table public.optimization_rollouts (
  id             uuid primary key default gen_random_uuid(),
  candidate_id   uuid not null references public.optimization_candidates(id) on delete cascade,
  instance_index integer not null,
  phase          text not null check (phase in ('minibatch', 'pareto')),
  agent_output   text,
  trace          jsonb,                  -- Tier 2 module I/O (D3); null in v1
  created_at     timestamptz not null default now(),
  constraint optimization_rollouts_unique unique (candidate_id, instance_index, phase)
);

create index optimization_rollouts_candidate_idx on public.optimization_rollouts(candidate_id, phase);

-- Per-criterion judge output for a Rollout (reuses evaluateRun's logic). The per-instance
-- score vector Pareto selection needs is derived by aggregating these across criteria.
create table public.rollout_results (
  id             uuid primary key default gen_random_uuid(),
  rollout_id     uuid not null references public.optimization_rollouts(id) on delete cascade,
  criterion_name text not null,
  score          numeric(4,3) not null,
  reasoning      text not null,
  constraint rollout_results_unique unique (rollout_id, criterion_name)
);

create index rollout_results_rollout_idx on public.rollout_results(rollout_id);

-- RLS on, no policies: these tables are reached only through the service-role client (server
-- actions + worker), exactly like eval_runs. anon/authenticated get no direct access.
alter table public.optimization_runs       enable row level security;
alter table public.optimization_candidates enable row level security;
alter table public.optimization_inputs     enable row level security;
alter table public.optimization_rollouts   enable row level security;
alter table public.rollout_results         enable row level security;
