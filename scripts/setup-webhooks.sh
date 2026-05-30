#!/usr/bin/env bash
set -euo pipefail

# Colors
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
CYAN='\033[1;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${CYAN}▸${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET} $*"; }
error()   { echo -e "${RED}✗${RESET} $*" >&2; }
header()  { echo -e "\n${BOLD}=== $* ===${RESET}\n"; }

prompt_value() {
  local prompt_text="$1"
  local default="${2:-}"
  local value=""
  if [[ -n "$default" ]]; then
    read -rp "$(echo -e "${CYAN}?${RESET} $prompt_text [$default]: ")" value
    echo "${value:-$default}"
  else
    read -rp "$(echo -e "${CYAN}?${RESET} $prompt_text: ")" value
    echo "$value"
  fi
}

prompt_secret() {
  local prompt_text="$1"
  local value=""
  read -rsp "$(echo -e "${CYAN}?${RESET} $prompt_text: ")" value
  echo ""
  printf '%s' "$value"
}

# ── Collect domain ────────────────────────────────────────────────────────────
header "Webhook Setup"

echo "This script guides you through registering webhooks in Stripe and Clerk."
echo "Both require browser actions — this script will open URLs and wait for you."
echo ""

PROD_DOMAIN=$(prompt_value "Your production domain (e.g. yourdomain.com, without https://)")
STAGING_DOMAIN=$(prompt_value "Your staging domain (e.g. staging-baseline.vercel.app, without https://)")

PROD_URL="https://$PROD_DOMAIN"
STAGING_URL="https://$STAGING_DOMAIN"

# ── Stripe webhook ────────────────────────────────────────────────────────────
header "Stripe — Production webhook"

echo "Steps to complete in the Stripe Dashboard:"
echo ""
echo "  1. Open: https://dashboard.stripe.com/webhooks/create"
echo "     (Ensure you are in LIVE mode for production — toggle top-right)"
echo ""
echo "  2. Endpoint URL: ${PROD_URL}/api/webhooks/stripe"
echo ""
echo "  3. Select events to listen for:"
echo "       checkout.session.completed"
echo "       customer.subscription.updated"
echo "       customer.subscription.deleted"
echo "       invoice.payment_failed"
echo ""
echo "  4. Click Add endpoint"
echo ""
echo "  5. On the endpoint detail page, click Reveal signing secret"
echo "     Copy the whsec_... value"
echo ""
read -rp "$(echo -e "${CYAN}?${RESET} Press Enter when you have created the Stripe production endpoint...")"

STRIPE_PROD_SECRET=$(prompt_secret "Paste the Stripe production signing secret (whsec_...)")

header "Stripe — Staging webhook"

echo "Steps for Stripe STAGING (test mode) webhook:"
echo ""
echo "  1. Open: https://dashboard.stripe.com/test/webhooks/create"
echo "     (Ensure you are in TEST mode — toggle top-right)"
echo ""
echo "  2. Endpoint URL: ${STAGING_URL}/api/webhooks/stripe"
echo ""
echo "  3. Select the same events as production."
echo ""
echo "  4. Reveal signing secret and copy whsec_..."
echo ""
read -rp "$(echo -e "${CYAN}?${RESET} Press Enter when you have created the Stripe staging endpoint...")"

STRIPE_STAGING_SECRET=$(prompt_secret "Paste the Stripe staging signing secret (whsec_...)")

# ── Clerk webhook ─────────────────────────────────────────────────────────────
header "Clerk — Production webhook"

echo "Steps to complete in the Clerk Dashboard:"
echo ""
echo "  1. Open: https://dashboard.clerk.com"
echo "     Switch to your PRODUCTION instance (top-left switcher)"
echo ""
echo "  2. Navigate to: Configure -> Webhooks -> + Add endpoint"
echo ""
echo "  3. Endpoint URL: ${PROD_URL}/api/webhooks/clerk"
echo ""
echo "  4. Subscribe to these events:"
echo "       user.created"
echo "       organization.created"
echo "       organization.deleted"
echo ""
echo "  5. Save, then copy the Signing Secret (whsec_...)"
echo ""
read -rp "$(echo -e "${CYAN}?${RESET} Press Enter when you have created the Clerk production endpoint...")"

CLERK_PROD_SECRET=$(prompt_secret "Paste the Clerk production signing secret (whsec_...)")

header "Clerk — Staging webhook"

echo "Steps for Clerk STAGING (development instance) webhook:"
echo ""
echo "  1. In Clerk Dashboard, switch to your DEVELOPMENT instance"
echo ""
echo "  2. Configure -> Webhooks -> + Add endpoint"
echo ""
echo "  3. Endpoint URL: ${STAGING_URL}/api/webhooks/clerk"
echo ""
echo "  4. Subscribe to: user.created, organization.created, organization.deleted"
echo ""
echo "  5. Copy the Signing Secret"
echo ""
read -rp "$(echo -e "${CYAN}?${RESET} Press Enter when you have created the Clerk staging endpoint...")"

CLERK_STAGING_SECRET=$(prompt_secret "Paste the Clerk staging signing secret (whsec_...)")

# ── Apply secrets to Vercel ───────────────────────────────────────────────────
header "Applying webhook secrets to Vercel"

if command -v vercel &>/dev/null && [[ -f .vercel/project.json ]]; then
  info "Setting STRIPE_WEBHOOK_SECRET for production..."
  echo "$STRIPE_PROD_SECRET" | vercel env add STRIPE_WEBHOOK_SECRET production --force 2>/dev/null || \
    echo "$STRIPE_PROD_SECRET" | vercel env add STRIPE_WEBHOOK_SECRET production
  success "STRIPE_WEBHOOK_SECRET (production) set"

  info "Setting CLERK_WEBHOOK_SIGNING_SECRET for production..."
  echo "$CLERK_PROD_SECRET" | vercel env add CLERK_WEBHOOK_SIGNING_SECRET production --force 2>/dev/null || \
    echo "$CLERK_PROD_SECRET" | vercel env add CLERK_WEBHOOK_SIGNING_SECRET production
  success "CLERK_WEBHOOK_SIGNING_SECRET (production) set"

  info "Setting STRIPE_WEBHOOK_SECRET for preview..."
  echo "$STRIPE_STAGING_SECRET" | vercel env add STRIPE_WEBHOOK_SECRET preview --force 2>/dev/null || \
    echo "$STRIPE_STAGING_SECRET" | vercel env add STRIPE_WEBHOOK_SECRET preview
  success "STRIPE_WEBHOOK_SECRET (preview) set"

  info "Setting CLERK_WEBHOOK_SIGNING_SECRET for preview..."
  echo "$CLERK_STAGING_SECRET" | vercel env add CLERK_WEBHOOK_SIGNING_SECRET preview --force 2>/dev/null || \
    echo "$CLERK_STAGING_SECRET" | vercel env add CLERK_WEBHOOK_SIGNING_SECRET preview
  success "CLERK_WEBHOOK_SIGNING_SECRET (preview) set"

  echo ""
  info "Triggering a fresh production deploy to pick up the new secrets..."
  vercel deploy --prod
  success "Redeployed"
else
  warn "Vercel CLI not available or project not linked — set these manually in Vercel Dashboard:"
  echo ""
  echo "  Production environment:"
  echo "    STRIPE_WEBHOOK_SECRET        = $STRIPE_PROD_SECRET"
  echo "    CLERK_WEBHOOK_SIGNING_SECRET = $CLERK_PROD_SECRET"
  echo ""
  echo "  Preview environment:"
  echo "    STRIPE_WEBHOOK_SECRET        = $STRIPE_STAGING_SECRET"
  echo "    CLERK_WEBHOOK_SIGNING_SECRET = $CLERK_STAGING_SECRET"
fi

# ── Verify instructions ───────────────────────────────────────────────────────
header "Verification checklist"

echo "Complete these manual verification steps:"
echo ""
echo "  Stripe (production):"
echo "    1. Stripe Dashboard -> Webhooks -> your endpoint -> Send test webhook"
echo "    2. Select checkout.session.completed -> Send"
echo "    3. Expect 200 in Recent deliveries"
echo ""
echo "  Clerk (production):"
echo "    1. Clerk Dashboard (production instance) -> Webhooks -> your endpoint -> Send example"
echo "    2. Select user.created -> Send -> expect 200"
echo "    3. Check Supabase Studio that a row appeared in public.users"
echo "    4. Repeat for organization.created -> expect row in public.organizations"
echo ""
success "setup-webhooks.sh complete"
