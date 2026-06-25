-- Mistral runtime support (#204, provider #3): widen the provider_keys.provider
-- CHECK to admit 'mistral'. The provider list is single-sourced in code
-- (src/lib/llm/providers.ts → LLM_PROVIDERS); this DB backstop is widened by a
-- reviewed migration when that const grows (same discipline noted on the original
-- constraint in 20260613000000_provider_keys.sql). The inline check was
-- auto-named provider_keys_provider_check by Postgres.
alter table public.provider_keys
  drop constraint provider_keys_provider_check;
alter table public.provider_keys
  add constraint provider_keys_provider_check
  check (provider in ('anthropic', 'openai', 'google', 'mistral'));
