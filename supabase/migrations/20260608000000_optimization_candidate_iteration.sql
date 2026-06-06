-- Optimization loop (GEPA, #89): give each reflective-mutation child a stable per-iteration
-- identity. The propose Activity's reflection call is non-deterministic, so an at-least-once
-- retry could otherwise orphan a duplicate Candidate and re-spend a reflection call. The
-- budgeted loop assigns a 1-based `iteration`, unique within the run; proposeCandidate looks
-- up (opt_run_id, iteration) before reflecting, so a retry returns the existing child.
-- target_module records which Module the child mutated, for lineage / review legibility.

alter table public.optimization_candidates
  add column iteration int,
  add column target_module text;

-- One Candidate per (run, iteration). Partial: the seed (generation 0) has no iteration.
create unique index optimization_candidates_iteration_unique
  on public.optimization_candidates(opt_run_id, iteration)
  where iteration is not null;
