# Manual setup

One-time steps to run before the subscription tracer demo will work
end-to-end. Code changes are tracked separately; this file is only
the things you do **outside** the codebase.

## 1. Supabase: link + apply migrations

Install the CLI if you don't have it:
```bash
brew install supabase/tap/supabase
# or: npm i -g supabase
```

From the repo root:
```bash
supabase init
supabase link --project-ref <your-project-ref>   # find in Supabase dashboard URL
supabase db push                                  # applies supabase/migrations/*.sql
```

Verify in Supabase Studio → Table Editor: `users` and `customers`
exist; both show RLS enabled and zero policies.

## 2. Stripe: create a Product and Price

Stripe dashboard → **Products** → **+ Add product**:

- Name: anything (e.g. "Baseline Pro")
- Price model: **Recurring**, monthly
- Amount: anything (e.g. $20)

After save, copy the **Price ID** (starts with `price_…`, not
`prod_…`).

## 3. `.env.local`: add two keys

Append to `/home/kamick/baseline/.env.local`:
```
STRIPE_PRICE_ID=price_...                # from step 2
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

## 4. Stripe webhook tunnel

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

## 5. Telemetry: PostHog, Sentry, Clerk webhook

All three are optional — code no-ops when the env var is empty — but
the tracer-slice funnel dashboard only lights up once they're set.

### PostHog

1. Sign up at <https://posthog.com> (or self-host) and create a project.
2. Project Settings → copy the **Project API Key** (`phc_…`).
3. Set in `.env.local`:
   ```
   NEXT_PUBLIC_POSTHOG_KEY=phc_...
   NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com   # or eu.i.posthog.com
   ```

### Sentry

1. Sign up at <https://sentry.io>, create a Next.js project.
2. Copy the **DSN** from the project's client keys page.
3. Set in `.env.local` (both vars get the same DSN — one is exposed to the
   browser bundle, one is server-only):
   ```
   NEXT_PUBLIC_SENTRY_DSN=https://...ingest.sentry.io/...
   SENTRY_DSN=https://...ingest.sentry.io/...
   ```

### Clerk webhook (`auth.user_signed_up`) — prod only

This event requires Clerk's cloud to POST into your app, so the app
needs a publicly reachable URL. We **don't** wire this up in local
dev — running a tunnel for one event isn't worth the per-session
friction. The handler at `src/app/api/webhooks/clerk/route.ts` is
already prod-ready; it just doesn't run locally because
`CLERK_WEBHOOK_SIGNING_SECRET` is empty.

Configuration happens during the first deploy — see
**Going to production** below.

Net effect locally: 4 of 5 funnel steps fire from your laptop
(`app.page_viewed`, `auth.signup_started`, `billing.checkout_started`,
`billing.subscription_started`). `auth.user_signed_up` only appears
in PostHog after you deploy.

## 6. Demo

```bash
npm run dev      # starts next + stripe listen together
```

1. Open http://localhost:3000, sign in.
2. Click **Subscribe** → Stripe Checkout opens.
3. Pay with test card `4242 4242 4242 4242`, any future expiry, any CVC.
4. Redirected back to `/?checkout=success`.
5. Page now shows **Subscribed ✓** with the subscription id.

If it didn't work, check in this order:

- **`stripe listen` terminal** — does the `checkout.session.completed`
  line show `[200]`? `[400]` means signature mismatch (re-copy the
  `whsec_…` and restart `npm run dev`). `[500]` means the handler
  threw — check the `npm run dev` terminal.
- **Supabase Studio** — is there a row in `customers`? If not, the
  webhook never reached the DB.
- **`NEXT_PUBLIC_APP_URL`** — wrong value here means the
  success/cancel redirect goes to the wrong host.

---

## Going to production

The deploy story is: get the app on a public URL, point each external
service's webhook at that URL, and mirror env vars. The handler code
doesn't change between dev and prod — only env vars differ.

Order matters: deploy first to get a URL, then register webhooks
against that URL, then redeploy so the webhook secrets are in env.

### 1. Deploy to Vercel

```bash
npm i -g vercel    # if not already installed
vercel             # first run: link or create project
vercel --prod      # promote to production
```

You'll get a URL like `https://baseline.vercel.app` (or whatever
custom domain you attach in the Vercel dashboard).

### 2. Promote Clerk to a production instance

Your local `.env.local` currently uses a Clerk **development** instance
(its keys are `pk_test_…` / `sk_test_…` and the frontend host ends in
`*.clerk.accounts.dev`). Production needs its own instance with its
own keys.

1. Clerk Dashboard → instance switcher (top left) → **Create production
   instance**.
2. Tie it to your real domain when prompted. Clerk gives you DNS
   records — add them at your DNS provider. (Vercel-managed domains
   can use Vercel's DNS UI.)
3. Once Clerk shows the instance as verified, copy the new keys:
   - `pk_live_…` → `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   - `sk_live_…` → `CLERK_SECRET_KEY`

> Production instance has different keys *and* a different webhook
> endpoint than dev. The dev instance's webhooks (if you ever wire any
> up) don't carry over.

### 3. Mirror env vars into Vercel

Vercel → Project → **Settings → Environment Variables**. Add for the
**Production** environment:

| Var | Value |
|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_live_…` from step 2 |
| `CLERK_SECRET_KEY` | `sk_live_…` from step 2 |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` / `…_SIGN_UP_URL` / `…_FALLBACK_*` | same as local |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | same Supabase project (or a separate prod project) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_live_…` (or `pk_test_…` if you're not ready for real money) |
| `STRIPE_SECRET_KEY` | `sk_live_…` or `sk_test_…` matching the publishable key |
| `STRIPE_PRICE_ID` | a price id from the same mode (live vs test) as the keys above |
| `NEXT_PUBLIC_APP_URL` | `https://<your-domain>` |
| `NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST` | same as local |
| `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_DSN` | same as local |
| `STRIPE_WEBHOOK_SECRET` | leave blank for now — filled in step 4 |
| `CLERK_WEBHOOK_SIGNING_SECRET` | leave blank for now — filled in step 5 |

### 4. Register the Stripe production webhook

1. Stripe Dashboard → toggle to **Live mode** (top right) if going to
   real money; otherwise stay in Test mode for staging. The two modes
   have separate endpoints and separate secrets.
2. **Developers → Webhooks → Add endpoint**.
3. Endpoint URL: `https://<your-domain>/api/webhooks/stripe`.
4. Events: `checkout.session.completed` (add `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed` as the
   handler grows to handle them).
5. Save → **Reveal** signing secret → copy `whsec_…` →
   set `STRIPE_WEBHOOK_SECRET` in Vercel.

### 5. Register the Clerk production webhook

1. Clerk Dashboard → ensure you're on the **production instance** (top left).
2. **Webhooks → + Add endpoint**.
3. Endpoint URL: `https://<your-domain>/api/webhooks/clerk`.
4. Subscribe to `user.created` (add more as the handler grows).
5. Save → copy the **Signing Secret** (`whsec_…`) → set
   `CLERK_WEBHOOK_SIGNING_SECRET` in Vercel.

### 6. Redeploy to pick up the webhook secrets

```bash
vercel --prod
```

(Vercel auto-redeploys on `git push` once GitHub integration is on,
but env var changes need a fresh deploy either way.)

### 7. Verify each webhook end-to-end

**Stripe** — on the endpoint's Dashboard page click **Send test
webhook** → `checkout.session.completed` → Send. Expect a 200 in
"Recent deliveries". Stripe auto-retries failures with exponential
backoff for 3 days; a 400 (bad signature) retries forever until fixed.

**Clerk** — on the endpoint's page click **Send example** →
`user.created` → Send. Same idea: expect 200, check Supabase Studio
that a row landed in `public.users`.

**PostHog** — go to **Activity → Live events** and confirm
`auth.user_signed_up`, `billing.subscription_started`, etc. show up
when you trigger the real flows.

### Rules of thumb

- **One webhook endpoint per environment.** Don't share a single
  endpoint across prod/staging — you can't tell which env an event
  came from and you can't roll one secret without affecting the others.
- **Rotating a secret:** Stripe and Clerk both let you roll signing
  secrets in their dashboards; both accept the old secret alongside the
  new one for a grace window, so deploy the new env var before the
  grace expires.
- **Never log the raw request body or the signing secret.** Anyone
  with the secret can forge events that pass verification.
- **Mode-match Stripe keys and endpoints.** Test-mode keys ↔ test-mode
  endpoint, live-mode keys ↔ live-mode endpoint. Mixing them produces
  signature failures that look like bugs in your code.
- **Mode-match Clerk instances.** Dev-instance keys can't talk to a
  prod-instance webhook and vice versa.
