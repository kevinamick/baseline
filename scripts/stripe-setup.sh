#!/usr/bin/env bash
# Provision everything the app needs in a Stripe account (test or live) and
# wire the results into Vercel: products + prices for the paid plans, the
# restricted billing-portal configuration, the webhook endpoint, and the env
# vars the app resolves at runtime.
#
# Usage:
#   STRIPE_SECRET_KEY=sk_test_… scripts/stripe-setup.sh staging
#   STRIPE_SECRET_KEY=sk_live_… scripts/stripe-setup.sh prod --app-url https://<domain>
#   … --rotate-webhook    # delete + recreate the endpoint (new signing secret)
#   … --print-only        # create Stripe objects, print env, set nothing
#   … --no-deploy         # set Vercel env, skip the redeploy
#
# Idempotent by construction — safe to re-run:
#   * Products carry metadata baseline_plan=<slug>; found before created.
#   * Prices use lookup_keys (baseline_<slug>_monthly). An existing price with
#     the WRONG amount is superseded: a new price is created and takes over the
#     lookup_key (prices are immutable in Stripe).
#   * The portal configuration reuses the app's own marker
#     (metadata.baseline=baseline_billing_page_v1, see
#     src/lib/billing/portal-config.ts) so the app's fallback lookup finds the
#     same object; features mirror that file exactly.
#   * The webhook endpoint is keyed by URL. If it already exists, its event
#     list is updated in place; the signing secret is only issued at creation,
#     so STRIPE_WEBHOOK_SECRET is set only when created (or --rotate-webhook).
#
# Plan amounts are read from src/lib/billing/plans.ts at run time — the single
# source (#137) — never duplicated here. A price drift between Stripe and
# plans.ts is corrected toward plans.ts.
#
# Requirements: curl, jq, node (amount extraction), vercel CLI (logged in +
# linked) unless --print-only.

set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_NAME="${1:-}"; shift || true
[[ "$ENV_NAME" == "staging" || "$ENV_NAME" == "prod" ]] \
  || die "usage: scripts/stripe-setup.sh <staging|prod> [--app-url <url>] [--rotate-webhook] [--print-only] [--no-deploy]"

if [[ "$ENV_NAME" == "staging" ]]; then
  VERCEL_SCOPE="preview"
  APP_URL="https://baseline-git-develop-kevinamick81-3367s-projects.vercel.app"
  WANT_PREFIX="sk_test_"
else
  VERCEL_SCOPE="production"
  APP_URL=""
  WANT_PREFIX="sk_live_"
fi

ROTATE_WEBHOOK=false
PRINT_ONLY=false
DEPLOY=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-url) APP_URL="$2"; shift 2 ;;
    --rotate-webhook) ROTATE_WEBHOOK=true; shift ;;
    --print-only) PRINT_ONLY=true; shift ;;
    --no-deploy) DEPLOY=false; shift ;;
    *) die "unknown flag: $1" ;;
  esac
done

KEY="${STRIPE_SECRET_KEY:-}"
[[ -n "$KEY" ]] || die "STRIPE_SECRET_KEY must be set in the environment"
[[ "$KEY" == ${WANT_PREFIX}* ]] \
  || die "$ENV_NAME expects a ${WANT_PREFIX}* key — refusing to mix test/live modes"
[[ -n "$APP_URL" ]] || die "prod needs --app-url <https://domain>"
APP_URL="${APP_URL%/}"

# Stripe API helper: form-encoded, dies on Stripe error objects.
api() {
  local method="$1" path="$2"; shift 2
  local out
  out=$(curl -sS -X "$method" "https://api.stripe.com/v1/$path" -u "$KEY:" "$@")
  if [[ $(jq -r '.error.message // empty' <<<"$out") != "" ]]; then
    die "stripe $method /$path: $(jq -r '.error.message' <<<"$out")"
  fi
  printf '%s' "$out"
}

# ── 1. Plan amounts from the single source ───────────────────────────────────
read -r BUILDER_USD SCALE_USD < <(node -e '
  const fs = require("fs");
  const src = fs.readFileSync(process.argv[1], "utf8");
  const grab = (slug) => {
    const block = src.split(new RegExp("\\b" + slug + ":\\s*{"))[1];
    const m = block && block.match(/monthlyPriceUsd:\s*(\d+)/);
    if (!m) { console.error("cannot extract " + slug + " price from plans.ts"); process.exit(1); }
    return m[1];
  };
  console.log(grab("builder"), grab("scale"));
' "$REPO_ROOT/src/lib/billing/plans.ts")
echo "==> plans.ts: builder \$$BUILDER_USD/mo, scale \$$SCALE_USD/mo"

# ── 2. Products + prices per paid plan ───────────────────────────────────────
ensure_price() { # <slug> <display name> <usd>
  local slug="$1" name="$2" usd="$3" product price amount lookup="baseline_${1}_monthly"

  product=$(api GET "products/search" --data-urlencode "query=metadata['baseline_plan']:'$slug'" \
    | jq -r '.data[0].id // empty')
  if [[ -z "$product" ]]; then
    product=$(api POST "products" \
      -d "name=$name" -d "metadata[baseline_plan]=$slug" | jq -r .id)
    echo "    product created: $product ($name)" >&2
  else
    echo "    product exists:  $product ($name)" >&2
  fi

  price=$(api GET "prices" -G -d "lookup_keys[]=$lookup" -d "active=true" \
    | jq -r '.data[0].id // empty')
  amount=$(api GET "prices" -G -d "lookup_keys[]=$lookup" -d "active=true" \
    | jq -r '.data[0].unit_amount // empty')
  if [[ -n "$price" && "$amount" == "$((usd * 100))" ]]; then
    echo "    price exists:    $price (\$$usd/mo)" >&2
  else
    [[ -n "$price" ]] && echo "    price $price has amount $amount ≠ $((usd * 100)) — superseding (plans.ts wins)" >&2
    price=$(api POST "prices" \
      -d "product=$product" \
      -d "unit_amount=$((usd * 100))" \
      -d "currency=usd" \
      -d "recurring[interval]=month" \
      -d "lookup_key=$lookup" \
      -d "transfer_lookup_key=true" | jq -r .id)
    echo "    price created:   $price (\$$usd/mo)" >&2
  fi
  printf '%s' "$price"
}

echo "==> Builder"
PRICE_BUILDER=$(ensure_price builder "Baseline Builder" "$BUILDER_USD")
echo "==> Scale"
PRICE_SCALE=$(ensure_price scale "Baseline Scale" "$SCALE_USD")

# ── 3. Billing-portal configuration (mirrors portal-config.ts, same marker) ──
echo "==> Portal configuration"
PORTAL_ID=$(api GET "billing_portal/configurations" -G -d "active=true" -d "limit=100" \
  | jq -r '[.data[] | select(.metadata.baseline == "baseline_billing_page_v1")][0].id // empty')
if [[ -z "$PORTAL_ID" ]]; then
  PORTAL_ID=$(api POST "billing_portal/configurations" \
    -d "business_profile[headline]=Baseline — manage your team's billing details" \
    -d "features[payment_method_update][enabled]=true" \
    -d "features[invoice_history][enabled]=true" \
    -d "features[customer_update][enabled]=true" \
    -d "features[customer_update][allowed_updates][]=email" \
    -d "features[customer_update][allowed_updates][]=address" \
    -d "features[customer_update][allowed_updates][]=name" \
    -d "features[subscription_cancel][enabled]=false" \
    -d "features[subscription_update][enabled]=false" \
    -d "metadata[baseline]=baseline_billing_page_v1" | jq -r .id)
  echo "    created: $PORTAL_ID"
else
  echo "    exists:  $PORTAL_ID"
fi

# ── 4. Webhook endpoint ──────────────────────────────────────────────────────
# Every event type the route + billing lib consume (src/app/api/webhooks/
# stripe/route.ts and src/lib/billing/*). Keep in sync when handling new types.
WEBHOOK_URL="$APP_URL/api/webhooks/stripe"
EVENTS=(
  charge.dispute.created
  charge.refunded
  checkout.session.completed
  customer.subscription.created
  customer.subscription.deleted
  customer.subscription.updated
  invoice.created
  invoice.marked_uncollectible
  invoice.paid
  invoice.payment_failed
  invoice.payment_succeeded
  invoice.voided
  subscription_schedule.aborted
  subscription_schedule.canceled
  subscription_schedule.completed
  subscription_schedule.created
  subscription_schedule.released
  subscription_schedule.updated
)
EVENT_ARGS=(); for e in "${EVENTS[@]}"; do EVENT_ARGS+=(-d "enabled_events[]=$e"); done

echo "==> Webhook endpoint ($WEBHOOK_URL)"
EXISTING_WH=$(api GET "webhook_endpoints" -G -d "limit=100" \
  | jq -r --arg url "$WEBHOOK_URL" '[.data[] | select(.url == $url)][0].id // empty')

WEBHOOK_SECRET=""
if [[ -n "$EXISTING_WH" ]] && $ROTATE_WEBHOOK; then
  api DELETE "webhook_endpoints/$EXISTING_WH" >/dev/null
  echo "    rotated: deleted $EXISTING_WH"
  EXISTING_WH=""
fi
if [[ -z "$EXISTING_WH" ]]; then
  CREATED=$(api POST "webhook_endpoints" -d "url=$WEBHOOK_URL" "${EVENT_ARGS[@]}")
  WEBHOOK_SECRET=$(jq -r .secret <<<"$CREATED")
  echo "    created: $(jq -r .id <<<"$CREATED") (signing secret captured)"
else
  api POST "webhook_endpoints/$EXISTING_WH" "${EVENT_ARGS[@]}" >/dev/null
  echo "    exists:  $EXISTING_WH — event list synced; secret unchanged"
  echo "    (Stripe only reveals the secret at creation — --rotate-webhook to mint a new one)"
fi

# ── 5. Env wiring ────────────────────────────────────────────────────────────
if $PRINT_ONLY; then
  echo "==> --print-only: set these yourself:"
  echo "STRIPE_PRICE_BUILDER=$PRICE_BUILDER"
  echo "STRIPE_PRICE_SCALE=$PRICE_SCALE"
  echo "STRIPE_PORTAL_CONFIG_ID=$PORTAL_ID"
  [[ -n "$WEBHOOK_SECRET" ]] && echo "STRIPE_WEBHOOK_SECRET=$WEBHOOK_SECRET"
  exit 0
fi

echo "==> Setting Vercel env ($VERCEL_SCOPE scope)"
set_env() {
  local name="$1" value="$2"
  vercel env rm "$name" "$VERCEL_SCOPE" --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$name" "$VERCEL_SCOPE" --sensitive >/dev/null
  echo "    $name set"
}
set_env STRIPE_SECRET_KEY "$KEY"
set_env STRIPE_PRICE_BUILDER "$PRICE_BUILDER"
set_env STRIPE_PRICE_SCALE "$PRICE_SCALE"
set_env STRIPE_PORTAL_CONFIG_ID "$PORTAL_ID"
if [[ -n "$WEBHOOK_SECRET" ]]; then
  set_env STRIPE_WEBHOOK_SECRET "$WEBHOOK_SECRET"
else
  echo "    STRIPE_WEBHOOK_SECRET unchanged (endpoint pre-existing)"
fi

# ── 6. Redeploy (env is baked at deploy time) ────────────────────────────────
if $DEPLOY; then
  if [[ "$ENV_NAME" == "staging" ]]; then
    LATEST=$(vercel ls baseline --meta githubCommitRef=develop 2>/dev/null \
      | grep -oE 'https://[a-z0-9-]+\.vercel\.app' | head -1)
  else
    LATEST=$(vercel ls baseline --prod 2>/dev/null \
      | grep -oE 'https://[a-z0-9-]+\.vercel\.app' | head -1)
  fi
  [[ -n "$LATEST" ]] || die "no $ENV_NAME deployment found to redeploy (use --no-deploy to skip)"
  echo "==> Redeploying $LATEST with the new env"
  vercel redeploy "$LATEST" | tail -1
else
  echo "==> --no-deploy: remember to redeploy Vercel yourself (env is baked at deploy)"
fi

cat <<EOF

==> Done. Verify by behavior:
    1. Stripe dashboard → Webhooks → the endpoint shows the $ENV_NAME URL with
       ${#EVENTS[@]} events; send a test event and confirm a 2xx.
    2. Checkout a plan end-to-end (test card in staging; real card + refund in
       prod) — confirms prices, webhook secret, and the billing mirror.
EOF
