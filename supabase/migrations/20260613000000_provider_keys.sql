-- BYO Keys (#184): per-Team LLM provider keys in Supabase Vault. A Team stores
-- one key per provider as a (org, provider) pair; the row holds only a Vault
-- secret reference and a masked last4 — the plaintext key never lives in a
-- public table, is never returned by any API, and is read back only by the
-- worker (service role) at run time. Mirrors the Connections secret pattern
-- (20260531000000_create_connections.sql + _connection_secret_cleanup.sql).

create table public.provider_keys (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  -- The provider list is single-sourced in code (src/lib/llm/providers.ts); this
  -- check is the DB backstop, widened by reviewed migration when the const grows
  -- (same discipline as the Stripe price-env mapping).
  provider    text not null check (provider in ('anthropic', 'openai', 'google')),
  secret_id   uuid not null,                -- Vault secret id holding the key value
  last4       text,                         -- masked tail for display only
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- One key per provider per Team; replace is an upsert on this pair.
  unique (org_id, provider)
);

create index provider_keys_org_id_idx on public.provider_keys(org_id);

-- Deny-all + service-role bypass (house pattern): all access is via the app's
-- service-role client (scoped by org_id in code) and the worker. RLS on with no
-- policy denies anon/authenticated entirely — no cross-Team read is possible.
alter table public.provider_keys enable row level security;

-- Supabase Vault: secrets encrypted at rest. Already enabled by the Connections
-- migration; create-if-not-exists keeps this migration self-contained.
create extension if not exists supabase_vault with schema vault;

-- Wrapper called by the server action to store a key. Returns the secret id.
create or replace function public.create_provider_secret(p_secret text, p_name text)
returns uuid
language sql
security definer
set search_path = public, vault, pg_temp
as $$
  select vault.create_secret(p_secret, p_name);
$$;

-- Wrapper called by the worker to read the decrypted key at run time.
create or replace function public.get_provider_secret(p_secret_id uuid)
returns text
language sql
security definer
set search_path = public, vault, pg_temp
as $$
  select decrypted_secret from vault.decrypted_secrets where id = p_secret_id;
$$;

-- App-level cleanup for the one case a trigger can't see: the server action
-- creates the secret BEFORE upserting the row, so a failed upsert (or a replace
-- that swaps in a new secret) must delete the now-orphaned old secret itself.
create or replace function public.delete_provider_secret(p_secret_id uuid)
returns void
language sql
security definer
set search_path = public, vault, pg_temp
as $$
  delete from vault.secrets where id = p_secret_id;
$$;

-- DB-level guarantee: deleting a provider_keys row (direct delete or org cascade)
-- deletes its Vault secret too, so a removed key leaves nothing behind.
create or replace function public.provider_keys_delete_secret()
returns trigger
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
begin
  if old.secret_id is not null then
    delete from vault.secrets where id = old.secret_id;
  end if;
  return old;
end;
$$;

create trigger provider_keys_delete_secret_trigger
  after delete on public.provider_keys
  for each row
  execute function public.provider_keys_delete_secret();

-- Lock the vault wrappers to service_role only. revoke-from-public alone is NOT
-- enough on Supabase: ALTER DEFAULT PRIVILEGES grants EXECUTE on every new public
-- function directly to anon and authenticated at creation time, and those grants
-- survive a revoke from public — leaving the function callable via PostgREST
-- (/rest/v1/rpc/get_provider_secret) with an attacker-chosen p_secret_id. Only
-- supabaseAdmin (service_role) and the worker ever call these.
revoke execute on function public.create_provider_secret(text, text) from public, anon, authenticated;
revoke execute on function public.get_provider_secret(uuid)          from public, anon, authenticated;
revoke execute on function public.delete_provider_secret(uuid)       from public, anon, authenticated;
grant  execute on function public.create_provider_secret(text, text) to service_role;
grant  execute on function public.get_provider_secret(uuid)          to service_role;
grant  execute on function public.delete_provider_secret(uuid)       to service_role;
