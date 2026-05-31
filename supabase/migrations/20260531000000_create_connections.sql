-- A Connection is a Team-owned, reusable definition of how Baseline reaches an
-- external System. Slice 1 implements kind='agent' (an endpoint Baseline invokes);
-- kind='dataset' columns (max_rows, window_minutes) are reserved for slice 2.

create table public.connections (
  id               uuid primary key default gen_random_uuid(),
  org_id           text not null references public.organizations(id) on delete cascade,
  created_by       text not null references public.users(id) on delete cascade,
  name             text not null,
  kind             text not null default 'agent' check (kind in ('agent', 'dataset')),
  provider         text not null default 'custom',
  endpoint         text not null,
  auth_header      text,                 -- e.g. 'Authorization'; null = no auth
  auth_secret_id   uuid,                 -- Vault secret id holding the credential value
  request_template jsonb,                -- agent kind: body template with {{placeholders}}
  response_path    text not null,        -- dotted path to agent_output, e.g. 'output' or 'choices.0.message.content'
  max_rows         int,                  -- dataset kind (slice 2)
  window_minutes   int,                  -- dataset kind (slice 2)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index connections_org_id_created_at_idx on public.connections(org_id, created_at desc);

alter table public.connections enable row level security;

-- Supabase Vault: secrets encrypted at rest. The connections row stores only a
-- reference (auth_secret_id); the plaintext credential never lives in a public table.
create extension if not exists supabase_vault with schema vault;

-- Wrapper called by the server action to store a credential. Returns the secret id.
create or replace function public.create_connection_secret(p_secret text, p_name text)
returns uuid
language sql
security definer
set search_path = public, vault, pg_temp
as $$
  select vault.create_secret(p_secret, p_name);
$$;

-- Wrapper called by the worker to read the decrypted credential at invocation time.
create or replace function public.get_connection_auth(p_secret_id uuid)
returns text
language sql
security definer
set search_path = public, vault, pg_temp
as $$
  select decrypted_secret from vault.decrypted_secrets where id = p_secret_id;
$$;

-- Lock down to service_role only (mirrors the pgmq queue wrappers).
revoke execute on function public.create_connection_secret(text, text) from public;
revoke execute on function public.get_connection_auth(uuid)            from public;
grant  execute on function public.create_connection_secret(text, text) to service_role;
grant  execute on function public.get_connection_auth(uuid)            to service_role;
