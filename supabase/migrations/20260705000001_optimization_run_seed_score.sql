-- Persist the seed Candidate's overall score at run completion (#113): the read surface
-- (list + detail) used to recompute this on every read from the seed Candidate's full-set
-- rollout_results (overallScoreFromResults, deleted by this change), which drifts from the
-- worker's own evaluateRun weighting and breaks on post-run rubric edits. best_score already
-- rides the completion transition; seed_score joins it so seed -> best is read straight off
-- the row. Nullable: existing completed runs have no stored value and must claim no lift.

alter table public.optimization_runs
  add column seed_score numeric(4,3);

comment on column public.optimization_runs.seed_score is
  'Seed (Candidate 0) full-set overall score, persisted at the completion transition (#113). Null for runs completed before this column existed — the read surface must claim no lift in that case.';
