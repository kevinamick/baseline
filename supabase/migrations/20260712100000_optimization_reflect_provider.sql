-- Optimization Runs: explicit reflect/generation provider (#485).
--
-- A run's provider used to be DERIVED from its reflect model via the registry's model→provider
-- map, which falls back to Anthropic for unknown ids. That made non-registry models unusable:
-- a BYO Team picking a provider's freshly-shipped model (live-listed at wizard time, #485)
-- would resolve the wrong provider for worker key resolution and the judge-model derivation.
--
-- reflect_provider is the provider the run's reflect/generation model belongs to, stamped at
-- creation by createOptimizationRun (src/app/actions/optimizations.ts) after server-side
-- re-validation of the model/provider pair. Nullable: rows created before this column (and any
-- writer that omits it) fall back to the registry map (providerForModel) in the worker, so old
-- rows and registry models behave exactly as before. The value set mirrors LLM_PROVIDERS in the
-- shared registry (worker/src/providers/registry.ts) — widen this CHECK when a provider is added.

alter table "public"."optimization_runs"
  add column if not exists "reflect_provider" "text";

alter table "public"."optimization_runs"
  add constraint "optimization_runs_reflect_provider_check"
  check (
    "reflect_provider" is null
    or "reflect_provider" = any (array[
      'anthropic',
      'openai',
      'google',
      'mistral'
    ])
  );

comment on column "public"."optimization_runs"."reflect_provider" is
  'The provider serving this run''s reflect/generation model (#485), stamped at creation after '
  'server-side model/provider validation. Null falls back to the registry model→provider map '
  '(providerForModel), so pre-#485 rows and registry models resolve exactly as before.';
