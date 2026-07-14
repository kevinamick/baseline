-- Signup passes: close the direct GoTrue account-creation surfaces that bypass
-- the launch sign-up gate (#487, ADR-0017). The gate (#425/#426) lives in the
-- `signUp` server action, but GoTrue's REST endpoints (`POST /auth/v1/signup`,
-- `POST /auth/v1/otp` with create) are reachable directly with the public anon
-- key and never run app code. Fix: the app mints a short-lived single-use pass
-- for the submitted email on EVERY app-originated sign-up (gated or not),
-- bound to a per-request NONCE it also threads into supabase.auth.signUp's
-- options.data, immediately before calling it; a `before_user_created` GoTrue
-- auth hook (the Postgres function below, enabled via supabase/config.toml
-- locally and the Management API `hook_before_user_created_*` fields on hosted
-- projects) rejects any self-service email creation that does not present a
-- valid pass whose nonce matches, consuming the pass atomically.
--
-- The hook deliberately knows NOTHING about the PostHog gate flag,
-- Invitations, or Access Codes — "self-service account creation must originate
-- from the app" is its only rule, unconditional and permanent. It survives
-- gate-lift with no change: ungated sign-ups still flow through `signUp`, which
-- still mints the pass, and federated (OAuth) sign-ins are admitted on their
-- own (see below), so lift day only needs the OAuth config flipped back on.
--
-- Verified empirically against GoTrue v2.190.0 (local stack, #487/#489):
--   * the hook FIRES for anon `POST /auth/v1/signup`, for anon `POST
--     /auth/v1/otp` with create (email magic-link), and for
--     `inviteUserByEmail`;
--   * it does NOT fire for admin-API creates (`auth.admin.createUser`), so
--     scripts/seed-e2e.mjs, the e2e admin fixtures, and the Supabase
--     Dashboard's "Create user" button need no passes;
--   * it does NOT fire for duplicate-email signups (confirmed duplicates 422
--     before the hook; unconfirmed duplicates take the resend path), so the
--     anti-enumeration paths never reach it — their pass simply expires;
--   * `options.data` lands at `event->'user'->'user_metadata'` (this is where
--     the app-carried nonce arrives); an anon caller CANNOT forge
--     `event->'user'->'app_metadata'->>'provider'` through the /signup body —
--     GoTrue overwrites it to `email` from the verified identity, so the
--     provider-based OAuth admit below is safe against anon forgery;
--   * GoTrue lowercases the email before the hook sees it (the lower() below
--     is belt-and-suspenders; the app's EmailSchema normalizes too);
--   * a `{"error": {"http_code": 403, "message": ...}}` return surfaces
--     through supabase-js signUp as AuthApiError{status: 403, message}.
--
-- Known residual (documented in ADR-0017, a product-policy call, NOT closed
-- here): `inviteUserByEmail` fires the hook and its event payload is
-- byte-identical to an anon /signup (no requestor-role channel), so the hook
-- cannot admit a Dashboard "Send invitation" without also admitting the anon
-- bypass. Operators use the Dashboard's "Create user" (admin.createUser, which
-- never fires the hook) instead; the app itself never calls inviteUserByEmail.

-- Same platform-owned, pre-account posture as `invitations` / `access_codes`:
-- RLS enabled with NO policies (deny-all for anon/authenticated), written only
-- by the service-role app client and read only by the SECURITY DEFINER hook.
-- NOT tenant-scoped — never add to TENANT_SCOPED_TABLES / tenantDb.
create table public.signup_passes (
  id uuid primary key default gen_random_uuid(),
  -- Normalized (trimmed + lowercased) by the app's EmailSchema before insert.
  email text not null,
  -- Per-request secret the app generates at mint time and threads into
  -- supabase.auth.signUp's options.data (-> user_metadata). The hook consumes
  -- a pass ONLY when the presented nonce matches, so binding is (email, nonce)
  -- not email alone. Email-only binding let a direct-REST attacker racing a
  -- victim's sign-up consume the victim's freshly minted pass and create the
  -- account under the victim's email with the ATTACKER's password
  -- (pre-registration account takeover, #489). The nonce never reaches the
  -- browser (mint and signUp both run server-side), so an attacker cannot
  -- present it.
  nonce text not null,
  created_at timestamptz not null default now(),
  -- Short-lived by design: the pass only needs to outlive the gap between the
  -- app's mint and GoTrue's hook invocation within one signUp call. 10 minutes
  -- absorbs any serverless cold start / retry without becoming a lingering
  -- bearer credential.
  expires_at timestamptz not null default now() + interval '10 minutes',
  -- Single-use marker, set by the guarded UPDATE in the hook below. Consumed
  -- and expired rows are purged opportunistically by the app after each mint
  -- (src/lib/signup-passes/mint.ts) — no pg_cron sweep needed at this volume.
  consumed_at timestamptz
);

create index signup_passes_email_idx on public.signup_passes using btree (lower(email));
-- Supports the opportunistic purge's `where expires_at < cutoff` predicate
-- (src/lib/signup-passes/mint.ts) so it never degrades into a full-table scan.
create index signup_passes_expires_at_idx on public.signup_passes using btree (expires_at);

alter table public.signup_passes enable row level security;

-- The hook GoTrue invokes (as supabase_auth_admin) before persisting a new
-- user. Consume-newest-valid-pass is the same row-locked guarded-update
-- discipline as claim_access_code: `for update` serializes concurrent
-- consumers for the same (email, nonce) (a loser re-evaluates the predicate
-- after the lock holder commits and no longer sees an unconsumed row), and the
-- `consumed_at is null` guard on the UPDATE is belt-and-suspenders against
-- isolation-level surprises. SECURITY DEFINER (owner postgres) gives it direct
-- table access past the deny-all RLS.
create or replace function public.before_user_created_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_email text := lower(coalesce(event->'user'->>'email', ''));
  -- GoTrue sets provider from the verified identity; unforgeable via /signup.
  v_provider text := coalesce(event->'user'->'app_metadata'->>'provider', '');
  -- The per-request nonce the app carried in options.data (-> user_metadata).
  v_nonce text := coalesce(event->'user'->'user_metadata'->>'signup_nonce', '');
  v_pass_id uuid;
  -- Generic on purpose: one refusal for "no pass", "wrong nonce", "expired",
  -- "already consumed", and "no email at all" — a prober learns nothing about
  -- pass mechanics or gate state. Must stay byte-identical to
  -- SIGNUP_PASS_REJECTION_MESSAGE in src/lib/signup-passes/rejection.ts, which
  -- the signUp action matches on to map a hook rejection to the generic
  -- refusal.
  v_reject constant jsonb := jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Sign-up is not available.'
    )
  );
begin
  -- Federated / OAuth (any non-email, non-blank provider) identities are
  -- created during the provider token exchange and never traverse the app's
  -- signUp action, so they carry no pass. They are not the anon self-service
  -- email surface #487 closes, and the provider is unforgeable through
  -- /signup, so admit them — this is what lets OAuth come back on gate-lift
  -- day with only a config change (ADR-0017). A blank provider falls through
  -- to the pass check (fail-closed), covering anonymous sign-ins if ever
  -- enabled.
  if v_provider <> '' and v_provider <> 'email' then
    return '{}'::jsonb;
  end if;

  -- Self-service email creation (password signup or email OTP): require a
  -- valid, app-minted pass bound to BOTH the email and the presented nonce.
  if v_email = '' or v_nonce = '' then
    return v_reject;
  end if;

  select sp.id
    into v_pass_id
  from signup_passes sp
  where lower(sp.email) = v_email
    and sp.nonce = v_nonce
    and sp.consumed_at is null
    and sp.expires_at > now()
  order by sp.created_at desc
  limit 1
  for update;

  if v_pass_id is null then
    return v_reject;
  end if;

  update signup_passes
  set consumed_at = now()
  where id = v_pass_id
    and consumed_at is null;

  if not found then
    return v_reject;
  end if;

  return '{}'::jsonb;
end;
$$;

alter function public.before_user_created_hook(jsonb) owner to postgres;

-- Callable by GoTrue (supabase_auth_admin) and by the service-role client
-- (the consume-signup-pass integration test drives it through PostgREST rpc).
-- Revoked from everything else: public-schema functions are exposed at
-- /rest/v1/rpc/*, and an anon caller must not be able to burn someone's pass.
revoke execute on function public.before_user_created_hook(jsonb) from public, anon, authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.before_user_created_hook(jsonb) to supabase_auth_admin;
grant execute on function public.before_user_created_hook(jsonb) to service_role;
