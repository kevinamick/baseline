-- GEPA system-aware merge/crossover (#84): a hybrid Candidate combines two Pareto-frontier
-- parents' per-Module prompts, so it needs a second lineage pointer alongside the existing
-- parent_id. parent_id stays the PRIMARY lineage (the stronger parent by overall score, see
-- worker/src/gepa/merge.ts's combineModulePrompts) so every existing read of parent_id is
-- unaffected; merged_from_id is the secondary parent and is null for every non-merge Candidate
-- (the seed and ordinary mutation children).

alter table public.optimization_candidates
  add column merged_from_id uuid references public.optimization_candidates(id) on delete set null;

comment on column public.optimization_candidates.merged_from_id is
  'Secondary parent for a system-aware merge Candidate (#84); null for the seed and mutation children. parent_id remains the primary lineage.';
