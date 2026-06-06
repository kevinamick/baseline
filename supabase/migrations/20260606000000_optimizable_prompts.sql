-- Optimization loop, slice 1: optimizable prompts (Modules) on an agent Connection.
-- An agent Connection can declare named Modules, each with a seed prompt. At invocation
-- time the worker renders {{prompt:<module>}} placeholders from either the Module's seed
-- (normal runs) or a Candidate's prompt map (optimization runs). See CONTEXT.md and
-- docs/adr/0006-temporal-for-durable-orchestration.md.
--
-- Stored as a jsonb array of { "name": <module>, "seed": <text> } objects so the list of
-- Module names and their per-Module seed text live together. Null for dataset kinds and
-- for agent connections with no optimizable prompts (the existing {{user_input}}-only case).
alter table public.connections
  add column optimizable_prompts jsonb;
