-- Signup passes: close the direct GoTrue /auth/v1/signup bypass of the launch
-- sign-up gate (#487, ADR-0017). The gate (#425/#426) lives in the `signUp`
-- server action, but GoTrue's REST signup endpoint is reachable directly with
-- the public anon key and never runs app code. Fix: the app mints a short-lived
-- single-use pass for the submitted email on EVERY app-originated sign-up
-- (gated or not), immediately before calling supabase.auth.signUp; a
-- `before_user_created` GoTrue auth hook (the Postgres function below,
-- enabled via supabase/config.toml locally and the Management API
-- `hook_before_user_created_*` fields on hosted projects) rejects any user
-- creation that has no valid pass, consuming the pass atomically.
--
-- The hook deliberately knows NOTHING about the PostHog gate flag,
-- Invitations, or Access Codes — "account creation must originate from the
-- app" is its only rule, unconditional and permanent. It survives gate-lift
-- with no change: ungated sign-ups still flow through `signUp`, which still
-- mints the pass.
--
-- Verified empirically against GoTrue v2.190.0 (local stack, #487):
--   * the hook fires for anon /signup and for inviteUserByEmail;
--   * it does NOT fire for admin-API creates (auth.admin.createUser), so
--     scripts/seed-e2e.mjs and the e2e admin fixtures need no passes;
--   * it does NOT fire for duplicate-email signups (confirmed duplicates 422
--     before the hook; unconfirmed duplicates take the resend path), so the
--     anti-enumeration paths never reach it — their pass simply expires;
--   * GoTrue lowercases the email before the hook sees it (the lower() below
--     is belt-and-suspenders; the app's EmailSchema normalizes too);
--   * a `{"error": {"http_code": 403, "message": ...}}` return surfaces
--     through supabase-js signUp as AuthApiError{status: 403, message}.

-- Same platform-owned, pre-account posture as `invitations` / `access_codes`:
-- RLS enabled with NO policies (deny-all for anon/authenticated), written only
-- by the service-role app client and read only by the SECURITY DEFINER hook.
-- NOT tenant-scoped — never add to TENANT_SCOPED_TABLES / tenantDb.
create table public.signup_passes (
  id uuid primary key default gen_random_uuid(),
  -- Normalized (trimmed + lowercased) by the app's EmailSchema before insert.
  email text not null,
  created_at timestamptz not null default now(),
  -- Short-lived by design: the pass only needs to outlive the gap between the
  -- app's mint and GoTrue's hook invocation within one signUp call. 10 minutes
  -- absorbs any serverless cold start / retry without becoming a lingering
  -- bearer credential.
  expires_at timestamptz not null default now() + interval '10 minutes',
  -- Single-use marker, set by the guarded UPDATE in the hook below. Consumed
  -- and expired rows are purged opportunistically by the app on each mint
  -- (src/lib/signup-passes/mint.ts) — no pg_cron sweep needed at this volume.
  consumed_at timestamptz
);

create index signup_passes_email_idx on public.signup_passes using btree (lower(email));

alter table public.signup_passes enable row level security;

-- The hook GoTrue invokes (as supabase_auth_admin) before persisting a new
-- user. Consume-newest-valid-pass is the same row-locked guarded-update
-- discipline as claim_access_code: `for update` serializes concurrent
-- consumers for the same email (a loser re-evaluates the predicate after the
-- lock holder commits and no longer sees an unconsumed row), and the
-- `consumed_at is null` guard on the UPDATE is belt-and-suspenders against
-- isolation-level surprises. SECURITY DEFINER (owner postgres) gives it
-- direct table access past the deny-all RLS.
create or replace function public.before_user_created_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_email text := lower(coalesce(event->'user'->>'email', ''));
  v_pass_id uuid;
  -- Generic on purpose: one refusal for "no pass", "expired", "already
  -- consumed", and "no email at all" — a prober learns nothing about pass
  -- mechanics or gate state. Must stay byte-identical to
  -- SIGNUP_PASS_REJECTION_MESSAGE in src/lib/signup-passes/mint.ts, which the
  -- signUp action matches on to map a hook rejection to the generic gated
  -- refusal.
  v_reject constant jsonb := jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Sign-up is not available.'
    )
  );
begin
  if v_email = '' then
    return v_reject;
  end if;

  select sp.id
    into v_pass_id
  from signup_passes sp
  where lower(sp.email) = v_email
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
