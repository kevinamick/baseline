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

-- Atomic create-or-replace of a Team's key for a provider. Serializes per (org,
-- provider) under an advisory xact lock so two concurrent replaces can never
-- orphan a Vault secret: the whole swap — mint the new secret, repoint the row,
-- drop the old secret — happens in ONE transaction. If anything fails the tx
-- rolls back, including the freshly-minted secret, so there is never a dangling
-- secret. Returns the new secret id. (Doing this in the app across three RPCs
-- would race: both writers read the same old secret_id, both mint a new one, and
-- the loser's secret is overwritten on the row yet never deleted.)
create or replace function public.set_provider_key(
  p_org_id     uuid,
  p_provider   text,
  p_secret     text,
  p_last4      text,
  p_created_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_old_secret uuid;
  v_new_secret uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || p_provider, 0));

  select secret_id into v_old_secret
  from public.provider_keys
  where org_id = p_org_id and provider = p_provider;

  v_new_secret := vault.create_secret(
    p_secret,
    'pk:' || p_org_id || ':' || p_provider || ':' || extract(epoch from clock_timestamp())
  );

  insert into public.provider_keys (org_id, provider, secret_id, last4, created_by, updated_at)
  values (p_org_id, p_provider, v_new_secret, p_last4, p_created_by, now())
  on conflict (org_id, provider) do update
    set secret_id  = excluded.secret_id,
        last4      = excluded.last4,
        created_by = excluded.created_by,
        updated_at = excluded.updated_at;

  -- Purge the secret the row no longer references (the delete trigger only fires
  -- on row DELETE, not this UPDATE).
  if v_old_secret is not null and v_old_secret <> v_new_secret then
    delete from vault.secrets where id = v_old_secret;
  end if;

  return v_new_secret;
end;
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
revoke execute on function public.set_provider_key(uuid, text, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.get_provider_secret(uuid)                      from public, anon, authenticated;
grant  execute on function public.set_provider_key(uuid, text, text, text, uuid) to service_role;
grant  execute on function public.get_provider_secret(uuid)                      to service_role;
