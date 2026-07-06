-- Access Codes gate account creation during Baseline's invite-only launch phase
-- (ADR-0017, CONTEXT.md Access Code/Redemption; #426, the schema + atomic
-- redemption slice — #425 shipped the flag-gated sign-up enforcement and the
-- Invitation bypass ahead of this table existing).
--
-- Like invitations, these are PLATFORM-owned, pre-account tables: a person
-- redeems a code before they have an account, so there is no tenant (org_id)
-- to scope by at redemption time. RLS is deny-all with service-role-only
-- access, mirroring invitations' posture — never queried through tenantDb /
-- TENANT_SCOPED_TABLES.
--
-- A code is a bearer, plaintext identifier (not a hashed secret like an
-- Invitation token — ADR-0017 accepts that a guessed code only admits a
-- sign-up, not a takeover), matched CASE-INSENSITIVELY so an operator handing
-- one out over chat/email doesn't have to worry about a recipient's casing.
create table public.access_codes (
  id                uuid primary key default gen_random_uuid(),
  code              text not null,
  -- Redemption cap, enforced atomically by claim_access_code() below.
  max_redemptions   integer not null check (max_redemptions > 0),
  -- Running count of successful claims. Authoritative for the cap check (NOT a
  -- cache of access_code_redemptions' row count) — incremented inside the same
  -- guarded UPDATE that enforces the cap, and decremented again by
  -- release_access_code_claim() when a claimed code's sign-up fails before an
  -- account is actually created.
  redeemed_count    integer not null default 0 check (redeemed_count >= 0),
  -- Optional expiry. NULL = never expires.
  expires_at        timestamptz,
  -- Grant fields consumed by later slices (ADR-0017): a trial length and/or a
  -- Stripe coupon reference, applied at the redeemer's first Team's first
  -- checkout, optionally restricted to one Plan. All nullable — this slice
  -- only stores them; nothing reads them yet.
  trial_days        integer check (trial_days is null or trial_days > 0),
  stripe_coupon_id  text,
  plan_slug         text,
  created_at        timestamptz not null default now()
);

-- Case-insensitive uniqueness: "LAUNCH2026" and "launch2026" are the same code.
create unique index access_codes_code_lower_idx on public.access_codes (lower(code));

alter table public.access_codes enable row level security;
-- No policies: only the SECURITY DEFINER functions below, plus the app's
-- service-role client (minting + redemption-count read-back), ever touch it.

-- One row per successful redemption, for attribution and the first-Team
-- binding a later slice adds. Not written by claim_access_code() itself — the
-- claim only reserves a slot on access_codes before a user exists; the app
-- inserts this row once auth.signUp actually produces a new account (see
-- src/lib/access-codes/redeem.ts).
create table public.access_code_redemptions (
  id                    uuid primary key default gen_random_uuid(),
  access_code_id        uuid not null references public.access_codes(id) on delete cascade,
  user_id               uuid not null references public.users(id) on delete cascade,
  -- Stamped later (next slice) when the redeemer creates their first Team — a
  -- redemption's benefit binds to that Team and is evaluated once, at its
  -- first checkout (ADR-0017); it never transfers to an existing Team.
  org_id                uuid references public.organizations(id) on delete set null,
  -- NULL until the benefit is applied (or forfeited) at that first checkout.
  benefit_consumed_at   timestamptz,
  created_at            timestamptz not null default now()
);

create index access_code_redemptions_access_code_id_idx
  on public.access_code_redemptions (access_code_id);
create index access_code_redemptions_user_id_idx
  on public.access_code_redemptions (user_id);

alter table public.access_code_redemptions enable row level security;
-- No policies: service-role only. A plain insert with no cap to guard needs
-- no RPC.

-- ---------------------------------------------------------------------------
-- Atomic claim (ADR-0017): the cap check and the redemption-count increment
-- are ONE guarded write, so concurrent sign-up submits for the same code can
-- never jointly exceed max_redemptions. `select ... for update` takes a
-- per-row lock so concurrent claimants serialize; the UPDATE's own
-- `where redeemed_count < max_redemptions` is a belt-and-suspenders second
-- guard against any isolation surprise. Called BEFORE supabase.auth.signUp —
-- the caller has no user yet, so this only reserves a slot on access_codes;
-- the access_code_redemptions row is inserted afterwards, once the new user's
-- id is known.
create or replace function public.claim_access_code(p_code text)
returns table (
  claimed          boolean,
  status           text,
  access_code_id   uuid,
  trial_days       integer,
  stripe_coupon_id text,
  plan_slug        text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id      uuid;
  v_max     integer;
  v_count   integer;
  v_expires timestamptz;
  v_trial   integer;
  v_coupon  text;
  v_plan    text;
begin
  select ac.id, ac.max_redemptions, ac.redeemed_count, ac.expires_at,
         ac.trial_days, ac.stripe_coupon_id, ac.plan_slug
    into v_id, v_max, v_count, v_expires, v_trial, v_coupon, v_plan
  from access_codes ac
  where lower(ac.code) = lower(p_code)
  for update;

  if not found then
    return query select false, 'not_found'::text, null::uuid, null::integer, null::text, null::text;
    return;
  end if;

  if v_expires is not null and v_expires < now() then
    return query select false, 'expired'::text, v_id, v_trial, v_coupon, v_plan;
    return;
  end if;

  if v_count >= v_max then
    return query select false, 'exhausted'::text, v_id, v_trial, v_coupon, v_plan;
    return;
  end if;

  update access_codes
  set redeemed_count = redeemed_count + 1
  where id = v_id
    and redeemed_count < max_redemptions;

  if not found then
    -- Shouldn't be reachable given the row lock above; guards against any
    -- isolation-level surprise rather than trusting FOR UPDATE alone.
    return query select false, 'exhausted'::text, v_id, v_trial, v_coupon, v_plan;
    return;
  end if;

  return query select true, 'claimed'::text, v_id, v_trial, v_coupon, v_plan;
end;
$$;

revoke execute on function public.claim_access_code(text) from public;
grant  execute on function public.claim_access_code(text) to service_role;

-- Hands a claimed slot back when the sign-up it was claimed for doesn't
-- actually produce a new account: supabase.auth.signUp itself erroring, or the
-- anti-enumeration path (an existing email — signUp returns an obfuscated user
-- with an empty `identities` array and no new row is created). Floored at 0 so
-- a duplicate release (there shouldn't be one; belt-and-suspenders) can't drive
-- the count negative and desync it from access_code_redemptions. An
-- unconfirmed-but-created account never reaches this function — its slot is
-- kept, by design (ADR-0017).
create or replace function public.release_access_code_claim(p_access_code_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update access_codes
  set redeemed_count = greatest(redeemed_count - 1, 0)
  where id = p_access_code_id;
$$;

revoke execute on function public.release_access_code_claim(uuid) from public;
grant  execute on function public.release_access_code_claim(uuid) to service_role;
