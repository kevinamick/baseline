-- Rate-limiting store for auth/email-sending surfaces (#209, ADR-0010:
-- docs/adr/0010-postgres-backed-fail-open-rate-limiting.md).
--
-- Postgres over Redis: these surfaces are low-frequency by nature, so a single
-- atomic increment per attempt is cheap enough — no new vendor, env vars, or e2e
-- stub. A SECURITY DEFINER `INSERT … ON CONFLICT … RETURNING count` is the whole
-- mechanism; the app calls it through the existing supabase-js .rpc() client
-- (no raw `pg` pool exists, which is why rate-limiter-flexible was rejected).
--
-- GDPR: a raw IP/email is personal data, so the natural key is stored HASHED
-- (sha256(surface:keytype:normalized) computed app-side). `surface`/`keytype`
-- stay cleartext for tuning. The table therefore holds no directly-readable PII.

create extension if not exists pg_cron;

create table public.rate_limit_hits (
  -- sha256(surface:keytype:normalized_value), hex. The raw IP/email never lands here.
  hashed_key   text        not null,
  -- Fixed-window bucket start (app floors now() to the window). One row per
  -- (key, window); the count resets simply by a new window producing a new row.
  window_start timestamptz not null,
  -- Cleartext, non-PII, for tuning/observability.
  surface      text        not null,
  keytype      text        not null,
  count        integer     not null default 0,
  primary key (hashed_key, window_start)
);

alter table public.rate_limit_hits enable row level security;
-- No policies: only the SECURITY DEFINER function (and service_role) ever touch it.

-- Atomic per-attempt increment. Returns the post-increment count for the window,
-- so the caller blocks when the returned value exceeds the surface's limit. The
-- ON CONFLICT update is a single statement under a row lock, so concurrent calls
-- for the same (key, window) cannot lose updates or overcount.
create or replace function public.increment_rate_limit(
  p_hashed_key   text,
  p_window_start timestamptz,
  p_surface      text,
  p_keytype      text
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  insert into public.rate_limit_hits (hashed_key, window_start, surface, keytype, count)
  values (p_hashed_key, p_window_start, p_surface, p_keytype, 1)
  on conflict (hashed_key, window_start)
  do update set count = public.rate_limit_hits.count + 1
  returning public.rate_limit_hits.count into v_count;

  return v_count;
end;
$$;

revoke execute on function public.increment_rate_limit(text, timestamptz, text, text) from public;
grant  execute on function public.increment_rate_limit(text, timestamptz, text, text) to service_role;

-- Sweep index: the daily cleanup scans by window_start.
create index if not exists rate_limit_hits_window_start_idx
  on public.rate_limit_hits(window_start);

-- Expired-row cleanup: a daily DELETE of anything older than a day comfortably
-- exceeds the longest window (1 hour). Scale-appropriate for low write volume;
-- the migration trigger to daily partitioning (O(1) drops) is only if the table
-- ever gets hot (ADR-0010).
do $$
begin
  perform cron.unschedule('rate-limit-sweep');
exception when others then
  null;
end
$$;

select cron.schedule(
  'rate-limit-sweep',
  '17 3 * * *',
  $$ delete from public.rate_limit_hits where window_start < now() - interval '1 day'; $$
);
