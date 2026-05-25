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

## 4. Stripe webhook tunnel (every dev session)

### One-time: install the Stripe CLI (WSL/Ubuntu)

```bash
curl -s https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public \
  | sudo gpg --dearmor -o /usr/share/keyrings/stripe.gpg

echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" \
  | sudo tee /etc/apt/sources.list.d/stripe.list

sudo apt update && sudo apt install -y stripe
stripe login    # opens a URL — click Allow in browser
```

### Run the tunnel

In a dedicated terminal:
```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

The first line of its output is a signing secret like
`whsec_…`. **This is a dev-only secret, different from the production
endpoint secret.** Copy it into `.env.local`, replacing the
placeholder:
```
STRIPE_WEBHOOK_SECRET=whsec_...
```
Restart `npm run dev` so the new env var is picked up.

This local secret is **stable** — every subsequent `stripe listen`
prints the same `whsec_…` for your Stripe account on this machine. Set
it once; it only changes if you log into a different account, reinstall
on a new machine, or explicitly rotate.

Leave `stripe listen` running for the rest of the session — it
forwards real Stripe events from your account to your local handler.

## 5. Demo

```bash
npm run dev      # terminal 1
stripe listen --forward-to localhost:3000/api/webhooks/stripe   # terminal 2 (already running)
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

The dev setup above uses `stripe listen` to tunnel events to your
laptop. Production uses a **real webhook endpoint** registered in the
Stripe dashboard, with a separate signing secret. The handler code
doesn't change — only the `STRIPE_WEBHOOK_SECRET` env var differs per
environment.

### One-time per environment (prod, staging, …)

1. Stripe dashboard → toggle to **Live mode** (top right) if this is
   production. (Test mode and live mode have separate endpoints and
   separate secrets — use test mode for staging.)
2. **Developers → Webhooks → Add endpoint**.
3. Endpoint URL: `https://<your-domain>/api/webhooks/stripe`.
4. Events to send: **`checkout.session.completed`** for now. Add more
   (`customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`) as you handle them in the route.
5. Save. On the endpoint detail page click **Reveal** under "Signing
   secret" — copy the `whsec_…`.
6. Set in your hosting provider's env vars:
   - `STRIPE_SECRET_KEY=sk_live_…` (or `sk_test_…` for staging)
   - `STRIPE_WEBHOOK_SECRET=whsec_…` (the one you just copied)
   - `STRIPE_PRICE_ID=price_…` (live-mode price for prod, test-mode for staging)
   - `NEXT_PUBLIC_APP_URL=https://<your-domain>`
   - Same for `NEXT_PUBLIC_CLERK_*`, `CLERK_SECRET_KEY`, Supabase keys.
7. Deploy.

### Verify in prod

After the first deploy, on the webhook endpoint's detail page click
**Send test webhook** → pick `checkout.session.completed` → Send.
Expect a 200 in the dashboard's "Recent deliveries" list. Stripe
auto-retries failed deliveries with exponential backoff for 3 days,
so a transient 500 isn't catastrophic — but a 400 (bad signature)
will retry forever until you fix the secret.

### Rules of thumb

- **One endpoint per environment.** Don't share a single endpoint
  across prod/staging — you can't tell which env an event came from
  and you can't roll one secret without affecting the others.
- **Rotating the secret:** click "Roll secret" in the dashboard.
  Stripe accepts the old secret for 24 hours alongside the new one,
  giving you time to deploy the new env var without dropped events.
- **Never log the raw request body or the signing secret.** Anyone
  with the secret can forge events that pass verification.
- **Test mode keys ↔ test mode endpoint, live mode keys ↔ live mode
  endpoint.** Mixing them produces signature failures that look like
  bugs in your code.
