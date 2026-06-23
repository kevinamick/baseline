-- Simple (Monte Carlo) optimization mode (#316, ADR-0015). A second Optimization Mode
-- alongside GEPA/Reflective: it samples scored rewrite Candidates and keeps the best,
-- with no Reflection. Two schema widenings — the mode flag on the run, and a 'full'
-- rollout phase for Simple's full-set scorings (it has no minibatch accept/reject step).

-- The Mode the run searches in. Mirrors the OPTIMIZATION_MODES const in
-- src/types/optimization.ts (one const list -> derived type). Existing rows are all
-- GEPA, so the default backfills them to 'reflective'; new runs set it explicitly.
alter table public.optimization_runs
  add column mode text not null default 'reflective'
  check (mode in ('simple', 'reflective'));

-- Widen the rollout phase CHECK to admit 'full'. A Simple Candidate is scored once on
-- the whole frozen set (no minibatch accept/reject), recorded as phase 'full'. Drop and
-- re-add the inline constraint by its generated name (the append-only widening pattern).
alter table public.optimization_rollouts
  drop constraint optimization_rollouts_phase_check;

alter table public.optimization_rollouts
  add constraint optimization_rollouts_phase_check
  check (phase in ('minibatch', 'pareto', 'full'));
