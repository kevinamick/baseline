# Production launch runbook

How to stand up the production environment: Supabase, Temporal Cloud, the Fly
worker, PostHog, Vercel, Stripe, and email — in the order that avoids rework.

**What already exists.** The prod deploy skeleton is live in CI: a push to
`main` runs `migrate-prod` (`supabase db push` against
`secrets.SUPABASE_PROJECT_ID_PROD`, gated on the full test matrix) and
`deploy-auth-emails` (Management-API template push, paths-filtered). Both read
the GitHub **Production** environment. Staging runs the same shape on
`develop`: Vercel branch URL, Supabase ref `rtvcpeiabmdnbzhuafrk` (manual
`db push`), Fly worker `baseline-7e62lg`.

---

## 1. Supabase (prod project)

Create a new project in the existing Supabase org, region **us-east-1**
(colocates with the Fly worker's `iad` and Vercel's default).

- [ ] **Merge the migration squash first** (PR #442) so prod's first
      `db push` applies one clean baseline instead of replaying the 47-file
      chain. Prod migration history starts at a single version.
- [ ] Fill the GitHub **Production** environment secrets:
      `SUPABASE_PROJECT_ID_PROD`, `SUPABASE_DB_PASSWORD_PROD`,
      `SUPABASE_ACCESS_TOKEN`. From then on, migrations and auth-email
      templates ship themselves on pushes to `main`.
- [ ] Dashboard → Auth: set the **site URL** and **redirect allow-list** to
      the prod domain. Do this by hand — `supabase config push` is
      deliberately NOT used (it clobbers `[auth]` wholesale; see #346 and
      `deploy-auth-emails.yml`).
- [ ] Dashboard → Auth → SMTP: prod SMTP credentials. The committed
      `config.toml` leaves `[auth.email.smtp]` off so local + CI keep
      capturing mail in Mailpit.
- [ ] Leave **OAuth providers disabled**. This is the ADR-0017 invariant
      while the sign-up gate is on (OAuth creates the Supabase user before
      app code can demand an Access Code), not a gap. OAuth returns with the
      gate-lift milestone.
- [ ] Verify the baseline applied: 5 cron jobs in `cron.job`, the `eval_runs`
      pgmq queue, the `on_auth_user_created` trigger, and spot-check the
      append-only ledger grants (no UPDATE/DELETE/TRUNCATE for
      `service_role` on `point_ledger`).

## 2. Temporal Cloud

ADR-0006 decided this: **Temporal Cloud** to start (~$100/mo Essentials),
self-hosting stays a config change, not a rewrite. The code is already
Cloud-shaped: a base64 mTLS cert pair in env flips TLS on
(`worker/src/temporal/connection.ts` and `src/lib/temporal/connection.ts`).

- [ ] Create the Cloud account and a `baseline-prod` namespace, AWS
      us-east-1.
- [ ] Run `scripts/temporal-certs.sh prod --fly-app <worker app>
      --namespace <ns.account>`. One run does the whole wiring:
      - generates the openssl CA + client cert (CA reused on later runs, so
        re-running is a cert rotation with no Temporal-side change);
      - generates `TEMPORAL_ENCRYPTION_KEY` (32-byte AES-256-GCM codec key,
        reused after first run — prod gets its own key by construction,
        since keys are stored per environment);
      - sets all five vars on **both** sides — Vercel Production env and
        Fly worker secrets: `TEMPORAL_ADDRESS` (derived
        `<ns.account>.tmprl.cloud:7233`), `TEMPORAL_NAMESPACE`, the TLS
        pair, and the encryption key;
      - triggers the Vercel redeploy itself (env is baked at deploy;
        `--no-deploy` to skip) — Fly restarts on its own.
- [ ] The one manual step: upload the printed CA to the Temporal Cloud
      namespace (Cloud UI → Namespaces → Edit → CA Certificates, or the
      `tcld accepted-client-ca add` command the script prints). Clients
      fail until it lands.
- [ ] Rotation semantics (also in the script header): plain re-run =
      client-cert rotation, safe anytime; `--rotate-ca` = new CA, needs the
      upload again; `--rotate-encryption-key` = **destructive** — in-flight
      workflows can no longer decode their payloads, so only during a quiet
      window.
- [ ] If staging is not on Cloud yet, run the same script with `staging`
      (its namespace and worker app are the defaults) and shake the mTLS +
      codec path out there first.

## 3. Fly (prod worker)

Second Fly app (e.g. `baseline-prod-worker`), same shape as staging.

- [ ] Copy `worker/fly.toml` with the new app name. Keep:
      - `auto_stop_machines = 'off'` — the Temporal worker is pull-based and
        receives no inbound traffic; the proxy's autostop would park it and
        nothing would ever wake it (observed in staging; documented in the
        file and ADR-0006).
      - One always-on machine (`fly scale count 1`).
      - The glibc image (`node:22-slim`) — Alpine breaks Temporal's
        core-bridge with `ERR_DLOPEN_FAILED`.
- [ ] `fly secrets set` the worker's env slice (matrix below). The managed
      `ANTHROPIC_API_KEY` must be a **new prod key with a spend limit**, not
      the dev/staging key.
- [ ] Deploy manually with `flyctl deploy` for launch. A `deploy-worker`
      GitHub workflow on `main` pushes is a fast-follow, not a blocker.
- [ ] Verify registration: `temporal task-queue describe` (both queues)
      shows pollers. A deployed-but-unregistered worker looks exactly like
      the local backlog incident — runs queue forever with no error.

## 4. PostHog (separate prod project)

Create a **second project** in the existing org ("Baseline prod"). One shared
project would pollute launch analytics with dev/staging events and — worse —
make `signup-access-code-gate` and the worker kill-switch flags shared levers
across environments. Per-project keys give env-scoped flags for free.

- [ ] Create the prod project; note both key pairs:
      - `NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST` — client
        analytics + error tracking, **inlined at build time**.
      - `POSTHOG_KEY` / `POSTHOG_HOST` — server-side: the sign-up gate
        evaluation (read at request time, by design — see the ADR-0017 slice
        1 notes in AGENTS.md) and app/worker structured logs.
- [ ] Recreate the flags in the prod project:
      - `signup-access-code-gate` — **ON** for the invite-only launch.
      - The worker kill-switch flags.
      Remember the gate **fails closed** (PostHog error/timeout → gated) and
      is **ungated only when `POSTHOG_KEY` is absent** — so prod must always
      have the key set, or registration opens.
- [ ] Consent posture is already correct (opt-in banner, #68); nothing to do.

## 5. Vercel

- [ ] `main` is the production branch; add the custom domain.
- [ ] Fill the **Production** env scope from the matrix below.
      `NEXT_PUBLIC_*` values are baked into the bundle at build time — any
      change needs a redeploy.
- [ ] `RATE_LIMIT_ENABLED=true` in prod (it's disabled for local e2e runs).
- [ ] `NEXT_PUBLIC_OAUTH_PROVIDERS` stays **unset** (gate invariant).

## 6. Stripe (live mode)

The most silent-failure-prone piece; the smoke test exercises all of it.

- [ ] Activate live mode and mint the live secret key.
- [ ] Run `STRIPE_SECRET_KEY=sk_live_… scripts/stripe-setup.sh prod
      --app-url https://<domain>`. One idempotent run provisions everything
      and wires Vercel Production env (then redeploys):
      - Builder + Scale products and monthly prices — amounts read from
        `plans.ts` at run time (drift corrects toward `plans.ts` by
        superseding the price via its `lookup_key`);
      - the restricted billing-portal configuration (same marker +
        features as `portal-config.ts`, so the app's fallback lookup finds
        the identical object);
      - the webhook endpoint at `/api/webhooks/stripe` with the full
        18-event set the route consumes, capturing the signing secret at
        creation (`--rotate-webhook` to mint a new one later);
      - env: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_BUILDER`,
        `STRIPE_PRICE_SCALE`, `STRIPE_PORTAL_CONFIG_ID`,
        `STRIPE_WEBHOOK_SECRET`.
      The key-prefix guard refuses a test key for prod (and vice versa).

## 7. Google Analytics & Search Console (SEO)

The SEO content surface (category + comparison pages, ADR-0013) needs Google's
own reporting alongside PostHog — Search Console for query/indexing data, GA4
for the acquisition view Google tools cross-link to.

- [ ] Create the GA4 property for the prod domain and set up the Google
      Analytics page/dashboard for SEO traffic (organic acquisition on the
      marketing + content routes).
- [ ] Any GA tag must load **behind the existing opt-in consent banner**
      (#68) — same posture as PostHog; no consent, no GA cookie.
- [ ] Verify the domain in Google Search Console and set
      `GOOGLE_SITE_VERIFICATION` in Vercel (see env matrix note); submit the
      sitemap.
- [ ] Link the GA4 property to Search Console.

## 8. Email

- [ ] Supabase Dashboard SMTP for auth mail (step 1).
- [ ] Resend for app mail: `RESEND_API_KEY`, `RESEND_FROM`,
      `EMAIL_TRANSPORT`.
- [ ] SPF/DKIM DNS records for the sending domain.

---

## Launch sequence

1. Merge PR #442 (squash) → create Supabase prod → set GitHub Production
   secrets → push to `main` and watch `migrate-prod` apply the baseline.
2. Temporal Cloud namespace → create the Fly prod app → `scripts/
   temporal-certs.sh prod …` (certs + all five Temporal vars on both sides +
   Vercel redeploy) → upload the CA → `flyctl deploy` the worker → confirm
   task-queue pollers.
3. PostHog prod project + flags → Vercel Production env + domain → deploy.
4. Stripe live mode + webhook.
5. **Smoke test, end to end:**
   - [ ] Mint an Access Code with the script against prod.
   - [ ] Sign up through the gate (and confirm a code-less sign-up is
         refused).
   - [ ] Create a Team, add a BYO provider key, run an eval.
   - [ ] Subscribe with a real card (then refund) — confirms live prices,
         webhook, and the billing mirror.
   - [ ] Run one small optimization run — confirms Temporal + worker +
         managed metering.
   - [ ] Check PostHog: events, logs (app + worker, correlated), no errors.

## Environment matrix

| Variable | Vercel (app) | Fly (worker) | GitHub Production |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✓ | | |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | ✓ | ✓ | |
| `SUPABASE_PROJECT_ID_PROD` / `SUPABASE_DB_PASSWORD_PROD` / `SUPABASE_ACCESS_TOKEN` | | | ✓ |
| `NEXT_PUBLIC_APP_URL` / `APP_URL` | ✓ | ✓ | |
| `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE` / `TEMPORAL_TLS_CERT` / `TEMPORAL_TLS_KEY` / `TEMPORAL_ENCRYPTION_KEY` — all five set by `scripts/temporal-certs.sh` | ✓ | ✓ | |
| `NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST` | ✓ | | |
| `POSTHOG_KEY` / `POSTHOG_HOST` | ✓ | ✓ | |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_BUILDER` / `STRIPE_PRICE_SCALE` / `STRIPE_PORTAL_CONFIG_ID` — all five set by `scripts/stripe-setup.sh` | ✓ | | |
| `ANTHROPIC_API_KEY` (managed key, prod-only, spend-limited) | | ✓ | |
| `RESEND_API_KEY` / `RESEND_FROM` / `EMAIL_TRANSPORT` | ✓ | ✓ | |
| `RETENTION_SECRET` / `MANAGED_THRESHOLD_SECRET` / `CLAIM_RESERVE_SECRET` / `WORKER_WAKE_SECRET` | ✓ | ✓ (wake) | |
| `RATE_LIMIT_ENABLED=true` | ✓ | | |
| `EVAL_JUDGE_CONCURRENCY` / `EVAL_AGENT_FANOUT_CONCURRENCY` / `ANTHROPIC_MODEL` (optional tuning) | | ✓ | |

Notes:
- Every secret gets a **fresh prod value** — no staging reuse. The Temporal
  five are covered by construction (`temporal-certs.sh` stores per-env
  material); the internal-route secrets and the managed Anthropic key are
  minted by hand.
- `GOOGLE_SITE_VERIFICATION` (Vercel) when Search Console is set up.
- The `*_API_BASE_OVERRIDE` vars are operator/dev-only (mock hosts); never
  set in prod — the fixed literal hosts are the #222 host-pinning guarantee.

## Worker capacity & scale-up triggers

One always-on machine (1 shared CPU / 1&nbsp;GB) goes further than it looks,
because the architecture caps load in layers:

- **Connections are not the constraint.** Temporal is pull-based: the worker
  holds one outbound gRPC connection to Temporal Cloud regardless of load,
  and tenants never connect to the worker at all.
- **Temporal worker slots (the ceiling).** `Worker.create`
  (`worker/src/temporal/worker.ts`) runs SDK defaults: **100 concurrent
  activity executions**, 40 concurrent workflow tasks. Every LLM call is an
  Activity, so ~100 simultaneous LLM calls per machine; excess work queues
  durably in Temporal — runs slow down, they never drop.
- **Per-run fan-out (the self-limiter).** Each eval run judges at
  `EVAL_JUDGE_CONCURRENCY` (default 5), so one run occupies ~5 slots →
  roughly **20 runs judging truly in parallel** per machine, more
  interleaving as slots recycle.
- **The real first limit** is usually the provider rate limit on the managed
  Anthropic key, not the machine — the work is I/O-bound waiting on LLM
  APIs, not CPU.

**Scale-up triggers to watch** (Temporal Cloud namespace metrics):

- **Activity schedule-to-start latency** is the canonical "add a worker"
  signal: sustained > a few seconds means work is waiting for slots.
- Worker memory approaching the 1 GB VM (cached workflow VMs) — scale RAM or
  count.
- Provider 429s in worker logs → raise the key's rate limit before adding
  machines (more workers make it worse, not better).

**How to scale:** `fly scale count 2` — Temporal load-balances the task
queue across pollers automatically; no coordination code, no config beyond
the machine count. Prefer more machines over raising
`EVAL_JUDGE_CONCURRENCY` on one machine: a higher per-run fan-out lets one
big tenant's run starve everyone else's slots, while extra machines add
fair capacity.

## After launch

- Staging's migration history still lists the old 47 versions: either
  `supabase db reset --linked` (wipes staging data) or
  `supabase migration repair` before its next `db push`.
- Fast-follows: `deploy-worker` workflow on `main`, and the gate-lift
  milestone (OAuth re-enable + Access Codes becoming trials/discounts only,
  per ADR-0017).
- Staging incident log from 2026-07-06 (all now BVT preflight items):
  Fly egress wobble (machine restart), empty/unverifiable `TEMPORAL_ADDRESS`
  + `TEMPORAL_NAMESPACE` in Vercel (Sensitive-type vars pull as `""` — the
  `?? "localhost:7233"` fallback does not catch empty strings), and a stale
  worker image missing `runEvalWorkflow` (deploy the worker whenever a new
  workflow type ships).
