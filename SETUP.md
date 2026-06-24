# Manual setup

One-time steps to run before the subscription tracer demo will work
end-to-end. Code changes are tracked separately; this file is only
the things you do **outside** the codebase.

## Branch model

Simplified gitflow. Three branch types, two long-lived:

- **`main`** — production. Deployed to the prod Vercel environment.
  Direct pushes blocked; merges come only from `develop`. Prod
  Supabase migrations auto-apply on merge (see §CI/CD).
- **`develop`** — staging. Deployed to a persistent Vercel preview
  alias (`staging-baseline.vercel.app` or similar). Stripe staging
  webhooks point here. Migrations applied manually.
- **`feature/*`** — short-lived. Branched from `develop`, PR'd back
  in. Each PR gets an ephemeral Vercel preview URL (no stable
  webhook config — webhook-touching features tested on `develop`).

Hotfix flow: branch from `main`, PR into `main`, then immediately
back-merge to `develop`. We don't use formal `release/*` branches
yet — when release coordination needs it, add them.

## Environments at a glance

| Branch | Vercel env | Vercel URL | Supabase project | Stripe mode |
|---|---|---|---|---|
| `main` | Production | `<your-domain>` | **prod** (new) | live (or test) |
| `develop` | Preview (aliased) | `staging-baseline.vercel.app` | **staging** (existing `rtvcpeiabmdnbzhuafrk`) | test |
| `feature/*` | Preview (ephemeral) | `<sha>-baseline.vercel.app` | staging (shared with develop) | test |

Auth is Supabase Auth, part of each Supabase project — there is no
separate auth provider or instance to track per environment.

## 1. Local Supabase (recommended for development)

Running Supabase locally means your dev work never touches the shared
staging database.

### Prerequisites

- **Docker Desktop** running (Supabase CLI uses it under the hood).
- **Supabase CLI** installed:
  ```bash
  brew install supabase/tap/supabase
  # or: npm i -g supabase
  ```

### Start the local stack

```bash
npm run db:start        # first run pulls Docker images (~1-2 min); subsequent runs are fast
```

On success, the CLI prints something like:

```
API URL: http://127.0.0.1:54321
DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres
Studio URL: http://127.0.0.1:54323
Anon Key: eyJ...
Service Role Key: eyJ...
```

Copy `.env.local.example` → `.env.local` and paste in the printed
`Anon Key` and `Service Role Key`:

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from above>
SUPABASE_SERVICE_ROLE_KEY=<service role key from above>
```

Do the same for the worker:

```bash
cp worker/.env.local.example worker/.env.local
# then paste the same SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
```

### Apply migrations

```bash
npm run db:reset        # runs all migrations + seeds against the local DB
```

### Useful commands

| Command | What it does |
|---|---|
| `npm run db:start` | Start the local Supabase stack (idempotent) |
| `npm run db:stop` | Stop all containers (data preserved) |
| `npm run db:reset` | Drop + recreate DB, re-run all migrations and seeds |
| `supabase migration up` | Apply newly-pulled migrations to the running stack **without** wiping data (use after `git pull` brings new migrations) |
| `supabase status` | Show running services and their URLs/keys |
| `supabase db diff` | Generate a migration from schema changes made in Studio |

**Supabase Studio** is available at <http://127.0.0.1:54323> while the
stack is running — use it to inspect tables, run SQL, and manage auth
users without touching staging.

---

## 2. Supabase: link + apply migrations (staging / production)

This section covers linking the CLI to a remote project. Skip it for
day-to-day local development — you only need it when pushing migrations
to staging or prod.

Install the CLI if you don't have it:
```bash
brew install supabase/tap/supabase
# or: npm i -g supabase
```

From the repo root:
```bash
supabase link --project-ref <your-project-ref>   # find in Supabase dashboard URL
supabase db push                                  # applies supabase/migrations/*.sql
```

Verify in Supabase Studio → Table Editor: `users`, `customers`, and
`billing_events` exist; `customers` (keyed by `org_id`) and
`billing_events` show RLS enabled and zero policies.

## 3. Stripe: create the plan Products and Prices

The pricing model has two paid plans (Builder, Scale — see
`src/lib/billing/plans.ts`). In the Stripe dashboard → **Products** →
**+ Add product**, create one **Recurring**, monthly product per plan
(amounts can be anything locally, e.g. $49 and $199).

After saving each, copy its **Price ID** (starts with `price_…`, not
`prod_…`) — one for Builder, one for Scale.

## 4. `.env.local`: add remaining keys

If you haven't already copied `.env.local.example` to `.env.local`, do
so now (the Supabase vars should already be filled from §1). Add:

```
STRIPE_PRICE_BUILDER=price_...           # Builder price id from step 3
STRIPE_PRICE_SCALE=price_...             # Scale price id from step 3
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

## 5. Stripe webhook tunnel

`npm run dev` auto-starts `stripe listen` alongside `next dev` (via
`concurrently`), so no separate terminal is needed once the one-time
install below is done.

### One-time: install the Stripe CLI (WSL/Ubuntu)

```bash
curl -s https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public \
  | sudo gpg --dearmor -o /usr/share/keyrings/stripe.gpg

echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" \
  | sudo tee /etc/apt/sources.list.d/stripe.list

sudo apt update && sudo apt install -y stripe
stripe login    # opens a URL — click Allow in browser
```

### One-time: capture the dev signing secret

First time you run `npm run dev`, the `[stripe]` stream prints a line
like `Your webhook signing secret is whsec_…`. Copy it into
`.env.local`, replacing the placeholder:

```
STRIPE_WEBHOOK_SECRET=whsec_...
```

Restart `npm run dev` so the new env var is picked up. This local
secret is **stable** — every subsequent `stripe listen` prints the
same `whsec_…` for your Stripe account on this machine. It only
changes if you log into a different account, reinstall on a new
machine, or explicitly rotate.

> If you don't want Stripe auto-starting, run `npm run dev:next`
> instead of `npm run dev` — that's just the Next server.

## 6. Telemetry: PostHog

PostHog is the single telemetry backend — product analytics, logs, and error
tracking (server-side via `instrumentation.ts`, client-side via autocapture).
It's optional — code no-ops when the env var is empty — but the tracer-slice
funnel dashboard and error tracking only light up once it's set.

### PostHog

1. Sign up at <https://posthog.com> (or self-host) and create a project.
2. Project Settings → copy the **Project API Key** (`phc_…`).
3. Set in `.env.local`:
   ```
   NEXT_PUBLIC_POSTHOG_KEY=phc_...
   NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com   # or eu.i.posthog.com
   ```

### Auth: nothing to configure

Authentication is Supabase Auth, which runs as part of the local
Supabase stack — there's no external provider to set up or enable. Users,
teams, and roles are owned by the app:

- **Sign up** at `/sign-up`; the `handle_new_user` trigger inserts the
  `public.users` row automatically.
- **Confirm** the email — locally, the confirmation message is delivered
  to **Mailpit** (<http://127.0.0.1:54324>), so no real mailbox is needed.
- **Create a team** at `/onboarding` after first sign-in; this inserts the
  `organizations` row and the owner's `admin` membership.

Social sign-in (Google/GitHub) is optional and off by default — see the
SOCIAL / OAUTH block in `.env.local.example` to turn a provider on.

## 7. Eval worker

The eval worker is a separate Node.js process that polls Supabase's pgmq queue, calls an LLM judge for each eval run, and sends completion emails (Resend in production; Mailpit locally). It lives in `worker/` and is deployed to Fly.io independently of the Next.js app.

### Resend (notification emails)

1. Sign up at <https://resend.com> and create a project.
2. **API Keys → Create API key** — give it Send access.
3. **Domains → Add domain** and follow the DNS verification steps (adds a few DKIM/SPF records). Emails must come from a verified domain; `resend.dev` is available for testing before your domain is set up.
4. Note your **From address** (e.g. `evals@yourdomain.com`).

### Worker env vars

Create `worker/.env.local` (never committed):

```
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...         # from Supabase → Settings → API → service_role key
ANTHROPIC_API_KEY=sk-ant-...
RESEND_API_KEY=re_...                    # production only; not needed locally (see Mailpit below)
RESEND_FROM=evals@yourdomain.com         # must match your verified Resend domain
APP_URL=http://localhost:3000            # used in email links; change to prod URL when deploying
LLM_PROVIDER=anthropic                  # startup default / logging — per-run provider is model-derived
```

Optional — add keys for any additional providers you want to test locally:
```
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
MISTRAL_API_KEY=...
```

**Local email via Mailpit.** When `MAILPIT_SMTP_HOST` is set, the worker routes
eval-run and optimization emails to the local Mailpit instance over SMTP instead
of Resend, so mail is inspectable at <http://127.0.0.1:54324> and never bounces
seed/test recipients off the real Resend account. `worker/.env.local.example`
ships the Supabase defaults (`MAILPIT_SMTP_HOST=127.0.0.1`,
`MAILPIT_SMTP_PORT=54325`). Leave both unset in production.

Optional overrides (defaults shown):
```
ANTHROPIC_MODEL=claude-opus-4-7
```

### Running the worker locally

Install the worker's dependencies once (they live in `worker/node_modules`, separate from the root):

```bash
cd worker && npm install && cd ..
```

After that, the worker starts automatically as part of the normal dev command:

```bash
npm run dev      # starts next + stripe + worker together
```

Worker output appears in the `[worker]` stream (green). It polls for jobs every 5 seconds — when you submit a "Run eval" from the UI you'll see it pick up the job and log progress there.

To test without the full UI, you can manually insert a row into `eval_runs` and call `select enqueue_eval_run('<uuid>')` in Supabase Studio's SQL editor.

## 8. Demo

```bash
npm run dev      # starts next + stripe listen together
```

1. Open http://localhost:3000, sign up, confirm via Mailpit, and create a
   Team at `/onboarding`. Billing is **Team-scoped** (ADR-0007), so you
   need a Team — and only a Contributor of it can subscribe.
2. Open **Pricing** (the nav link, or `/pricing`) and pick **Builder** or
   **Scale** → **Subscribe** → Stripe Checkout opens.
3. Pay with test card `4242 4242 4242 4242`, any future expiry, any CVC.
4. Redirected back to `/?checkout=success`.
5. A second or two later (once the subscription webhook lands), refresh —
   the landing page shows **Subscribed ✓** and the Pricing link disappears.

If it didn't work, check in this order:

- **`stripe listen` terminal** — do **both** `checkout.session.completed`
  *and* `customer.subscription.created`/`.updated` show `[200]`? The
  subscription event is the one that flips the mirror to active. `[400]`
  means signature mismatch (re-copy the `whsec_…` and restart
  `npm run dev`); `[500]` means the handler threw — check the
  `npm run dev` terminal.
- **Schema up to date?** If you just pulled the Team-billing migration,
  apply it: `supabase migration up` (keeps data) or `npm run db:reset`
  (wipes + re-seeds). A stale `customers` table — still keyed by
  `user_id`, with no `org_id`/`status` — silently blocks the flip.
- **Supabase Studio** — is there a row in `customers` for your Team's
  `org_id` with `status = active`? `billing_events` lists every webhook
  the handler has processed.
- **`NEXT_PUBLIC_APP_URL`** — wrong value here means the
  success/cancel redirect goes to the wrong host.

---

## Going to production

The deploy story is: get the app on public URLs (one per environment),
point each external service's webhook at the staging + prod URLs, and
mirror env vars per Vercel environment. The handler code doesn't change
between environments — only env vars differ.

Order matters: deploy first to get URLs, then register webhooks
against them, then redeploy so the webhook secrets are in env.

Throughout this section, "**staging**" = the `develop` branch's
Vercel preview alias; "**prod**" = the `main` branch's Vercel
Production deploy. Repeat steps 4 & 5 once per environment unless
noted.

### 1. Push the branches + connect Vercel

```bash
git checkout -b develop main
git push -u origin develop
```

Then in **Vercel → New Project → Import** the GitHub repo. After
import:

- **Settings → Git → Production Branch** = `main` (default).
- **Settings → Domains → Add** a stable alias and assign it to the
  `develop` branch — e.g. `staging-baseline.vercel.app`. This is what
  the Stripe staging webhook will point at.

Pushing `develop` deploys staging; pushing `main` deploys prod. CI
(see §CI/CD) gates these via PR checks.

### 2. Mirror env vars into Vercel

Vercel → Project → **Settings → Environment Variables**. Add for the
**Production** environment:

| Var | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | the prod Supabase project (auth lives here too) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_live_…` (or `pk_test_…` if you're not ready for real money) |
| `STRIPE_SECRET_KEY` | `sk_live_…` or `sk_test_…` matching the publishable key |
| `STRIPE_PRICE_BUILDER` / `STRIPE_PRICE_SCALE` | the per-plan price ids, from the same mode (live vs test) as the keys above |
| `NEXT_PUBLIC_APP_URL` | `https://<your-domain>` |
| `NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST` | same as local |
| `STRIPE_WEBHOOK_SECRET` | leave blank for now — filled in step 3 |
| `STRIPE_PORTAL_CONFIG_ID` | optional — pins the Customer Portal configuration (`bpc_…`). Unset, the app finds-or-creates a restricted config tagged `baseline_billing_page_v1` on first portal use; pin it in prod so a Dashboard edit can't be shadowed by re-creation |

### 3. Register the Stripe production webhook

1. Stripe Dashboard → toggle to **Live mode** (top right) if going to
   real money; otherwise stay in Test mode for staging. The two modes
   have separate endpoints and separate secrets.
2. Open **Workbench** (the developer panel — its launcher sits at the
   bottom-right of the Dashboard) → **Webhooks** tab →
   **Create an event destination**.

   > Workbench replaced the old Developers Dashboard, so there's no longer
   > a top-level **Developers → Webhooks** page. If your account still shows
   > the legacy Developers Dashboard, the equivalent path is
   > **Developers → Webhooks → Add endpoint**.
3. Select the **event types** to send — the handler mirrors subscription
   state from **all** of these (ADR-0008), so subscribe to every one:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`

   > A Team only shows as subscribed **after** a `customer.subscription.*`
   > event — `checkout.session.completed` alone links the Stripe customer
   > but doesn't set the status. Omitting the subscription events leaves
   > paid Teams stuck "unsubscribed".
4. **Continue** (accept the default API version) → choose **Webhook
   endpoint** as the destination type → set the **Endpoint URL** to
   `https://<your-domain>/api/webhooks/stripe`.
5. Save → **Reveal** the signing secret → copy `whsec_…` →
   set `STRIPE_WEBHOOK_SECRET` in Vercel.

### 4. Resend: verify your sending domain (production)

The Resend domain you verified during local setup works in production too — no separate step needed unless you want a different sending domain per environment. Just make sure `RESEND_FROM` on Fly.io matches the verified domain.

If you want a staging-specific address (e.g. `evals-staging@yourdomain.com`), the same domain covers it — only the local-part differs.

#### Point Supabase Auth's emails at Resend too

The app's invitations (`src/lib/email/send.ts`) and the worker's run emails
(`worker/src/emailer.ts`) already go through Resend in production. The third
category — the emails **Supabase Auth sends itself** (sign-up confirmation,
email-change, password recovery) — does *not* flow through that integration. By
default a deployed project falls back to Supabase's built-in sender, which is
rate-limited to a handful of emails/hour and not meant for production.

Route those through Resend so all transactional mail uses one provider. In the
Supabase Dashboard for the prod project → **Authentication → Emails → SMTP
Settings → Enable Custom SMTP**:

| Field | Value |
|---|---|
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | your `RESEND_API_KEY` |
| Sender email | an address on your Resend-verified domain (e.g. `noreply@yourdomain.com`) |
| Sender name | `Baseline` |

This mirrors the (disabled) `[auth.email.smtp]` block in `supabase/config.toml`,
which is left off locally so sign-up/reset emails keep landing in Mailpit. If you
manage the linked project's config via the CLI instead of the dashboard,
uncomment that block and run `supabase config push`. Either way, once custom SMTP
is on, raise `auth.rate_limit.email_sent` in `config.toml` from its local default
before relying on it.

### 5. Fly.io: deploy the eval worker

#### One-time: install the Fly CLI

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

#### Create the app (first deploy only)

```bash
cd worker
fly launch --no-deploy    # reads fly.toml; prompts for region, confirms app name
```

If the app name `baseline-eval-worker` in `fly.toml` is taken, either update the `app` field in `fly.toml` or pass `--name` to `fly launch`.

#### Set secrets

```bash
fly secrets set \
  SUPABASE_URL="https://<ref>.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
  ANTHROPIC_API_KEY="sk-ant-..." \
  RESEND_API_KEY="re_..." \
  RESEND_FROM="evals@yourdomain.com" \
  APP_URL="https://<your-domain>"
```

Optional — add any additional provider keys your Team will use as Managed Keys or BYO Key sources:
```bash
fly secrets set OPENAI_API_KEY="sk-..." GOOGLE_API_KEY="..." MISTRAL_API_KEY="..."
```

These are stored encrypted in Fly and injected at runtime — never in `fly.toml` or the image.

#### Deploy

```bash
fly deploy    # builds the Dockerfile and pushes to Fly
```

Monitor startup:
```bash
fly logs
```

#### Scaling

The worker runs **always-on**: `fly.toml` sets `min_machines_running = 1` (with `auto_stop_machines = 'stop'`), so Fly keeps at least one Machine running at all times and only auto-stops machines *above* that floor. This is required, not a cost oversight — the worker long-polls Temporal's task queues, and Temporal's pull model means nothing external can wake a stopped worker (see [ADR-0006](docs/adr/0006-temporal-for-durable-orchestration.md)). Do **not** scale the worker to zero. To run more workers in parallel (for many concurrent runs):

```bash
fly scale count 2    # run 2 workers in parallel
```

For scheduled evals (future): add a Fly Machine cron that pings a lightweight endpoint, or use Fly's built-in `[processes]` with a scheduled runner process alongside the queue worker.

#### Updating the worker

```bash
cd worker
fly deploy    # re-builds and rolls out; zero-downtime if >1 machine
```

### 6. Redeploy to pick up the webhook secrets

```bash
vercel --prod
```

(Vercel auto-redeploys on `git push` once GitHub integration is on,
but env var changes need a fresh deploy either way.)

### 7. Verify the webhook + auth end-to-end

**Stripe** — on the endpoint's Dashboard page click **Send test
webhook** → `checkout.session.completed` → Send. Expect a 200 in
"Recent deliveries". Stripe auto-retries failures with exponential
backoff for 3 days; a 400 (bad signature) retries forever until fixed.

**Auth** — sign up on the deployed app, confirm via the email, and
check Supabase Studio → Authentication that the user exists and that a
row landed in `public.users`. Create a team and confirm an
`organizations` + `memberships` row appear.

**PostHog** — go to **Activity → Live events** and confirm
`auth.user_signed_up`, `billing.subscription_started`, etc. show up
when you trigger the real flows.

### Rules of thumb

- **One webhook endpoint per environment.** Don't share a single
  endpoint across prod/staging — you can't tell which env an event
  came from and you can't roll one secret without affecting the others.
- **Rotating a secret:** Stripe lets you roll the signing secret in the
  dashboard; it accepts the old secret alongside the new one for a grace
  window, so deploy the new env var before the grace expires.
- **Never log the raw request body or the signing secret.** Anyone
  with the secret can forge events that pass verification.
- **Mode-match Stripe keys and endpoints.** Test-mode keys ↔ test-mode
  endpoint, live-mode keys ↔ live-mode endpoint. Mixing them produces
  signature failures that look like bugs in your code.

---

## CI/CD

GitHub Actions handle PR validation and prod migrations. Vercel
handles the actual deploys via its GitHub integration — CI never
runs `vercel deploy` itself.

### Workflow: `.github/workflows/ci.yml`

Two jobs in one file:

- **`ci`** — runs on every PR to `develop`/`main` and on pushes to
  both. Steps: lint → typecheck → vitest → `next build`.
- **`migrate-prod`** — runs only on `push` to `main`, after `ci`
  succeeds. Runs `supabase db push` against the prod project.

### GitHub repo Settings → Secrets and variables → Actions

**Secrets (encrypted, server-only):**

| Secret | Where to get it |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase Dashboard → Account → **Access Tokens** → Generate. Personal-account token; used by the CLI to auth. |
| `SUPABASE_DB_PASSWORD_PROD` | Supabase Dashboard → prod project → Settings → Database → connection password. |
| `SUPABASE_PROJECT_ID_PROD` | The project ref string from Supabase Dashboard → prod project URL (e.g. `abcd1234efgh`). |

**Variables (plaintext, fine to see):**

Mirror the `NEXT_PUBLIC_*` values from your staging/prod envs so
`next build` produces a working client bundle. Set under
**Variables** (not Secrets) so they're visible at a glance:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the
  **staging** Supabase project — auth is served from here)
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (test mode)
- `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`

The workflow has placeholder fallbacks for each so a forked-PR build
still runs, but the produced bundle won't be functional without real
values.

### GitHub branch protection (Settings → Branches)

Protect both `main` and `develop`:

- **Require a pull request before merging** — yes
- **Require status checks to pass before merging** — yes; check
  `ci` (the job name from the workflow)
- **Do not allow bypassing** — yes (apply to admins too, ideally)
- **Block force pushes**, **block deletions** — yes

This is what enforces "no direct pushes to main".

### Migration rollback

Supabase migrations are forward-only. If `migrate-prod` applies a
bad migration:

1. Write a new migration that undoes it (`supabase migration new
   revert_<name>`).
2. PR it through `develop` → `main` like any other change.
3. CI will apply it on merge.

No automated rollback — that would hide the failure and bypass code
review on the revert.

### Two Supabase projects

The repo currently has the existing project
(`rtvcpeiabmdnbzhuafrk`) linked as **staging**. Before the first
prod deploy, create a second Supabase project and treat it as prod:

1. Supabase Dashboard → **New Project** (same region as the
   existing one).
2. Save its project ref + DB password as
   `SUPABASE_PROJECT_ID_PROD` and `SUPABASE_DB_PASSWORD_PROD` in
   GitHub secrets.
3. Mirror schema once: from your laptop,
   `supabase link --project-ref <new-prod-ref>` →
   `supabase db push` — applies all existing migrations.
4. Mirror env vars: copy `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   from the new project into Vercel's **Production** env (only).
5. From then on, prod migrations flow through `migrate-prod`.
   Staging migrations stay manual: link to staging locally and
   `supabase db push` from your laptop while iterating.
