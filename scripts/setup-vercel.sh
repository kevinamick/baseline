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

prompt_secret() {
  local var_name="$1"
  local prompt_text="$2"
  local value=""
  read -rsp "$(echo -e "${CYAN}?${RESET} $prompt_text: ")" value
  echo ""
  printf '%s' "$value"
}

prompt_value() {
  local var_name="$1"
  local prompt_text="$2"
  local default="${3:-}"
  local value=""
  if [[ -n "$default" ]]; then
    read -rp "$(echo -e "${CYAN}?${RESET} $prompt_text [$default]: ")" value
    echo "${value:-$default}"
  else
    read -rp "$(echo -e "${CYAN}?${RESET} $prompt_text: ")" value
    echo "$value"
  fi
}

# ── Prerequisites ────────────────────────────────────────────────────────────
header "Checking prerequisites"

if ! command -v vercel &>/dev/null; then
  error "Vercel CLI not found."
  echo "  Install: npm i -g vercel"
  exit 1
fi
success "vercel CLI found ($(vercel --version 2>/dev/null | head -1))"

if ! command -v gh &>/dev/null; then
  error "gh (GitHub CLI) not found."
  echo "  Install: https://cli.github.com/"
  exit 1
fi
success "gh CLI found"

# Ensure logged in
if ! vercel whoami &>/dev/null; then
  info "Not logged in to Vercel. Running 'vercel login'..."
  vercel login
fi
success "Logged in to Vercel as $(vercel whoami)"

# ── Link / create Vercel project ─────────────────────────────────────────────
header "Linking Vercel project"

if [[ -f .vercel/project.json ]]; then
  success "Vercel project already linked (.vercel/project.json exists)"
else
  info "Linking project to Vercel (follow prompts)..."
  vercel link
  success "Vercel project linked"
fi

# ── Collect env var values ───────────────────────────────────────────────────
header "Collecting environment variable values"

echo "You will be prompted for values. Press Enter to skip optional vars."
echo ""

# Clerk
warn "--- Clerk ---"
CLERK_PUB_KEY=$(prompt_value CLERK_PUB_KEY "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (pk_live_...)")
CLERK_SECRET=$(prompt_secret CLERK_SECRET "CLERK_SECRET_KEY (sk_live_...)")
CLERK_SIGN_IN_URL=$(prompt_value CLERK_SIGN_IN_URL "NEXT_PUBLIC_CLERK_SIGN_IN_URL" "/sign-in")
CLERK_SIGN_UP_URL=$(prompt_value CLERK_SIGN_UP_URL "NEXT_PUBLIC_CLERK_SIGN_UP_URL" "/sign-up")
CLERK_FALLBACK_SIGN_IN=$(prompt_value CLERK_FALLBACK_SIGN_IN "NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL" "/")
CLERK_FALLBACK_SIGN_UP=$(prompt_value CLERK_FALLBACK_SIGN_UP "NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL" "/")

# Supabase
warn "--- Supabase ---"
SUPABASE_URL=$(prompt_value SUPABASE_URL "NEXT_PUBLIC_SUPABASE_URL (https://<ref>.supabase.co)")
SUPABASE_ANON_KEY=$(prompt_secret SUPABASE_ANON_KEY "NEXT_PUBLIC_SUPABASE_ANON_KEY")
SUPABASE_SERVICE_KEY=$(prompt_secret SUPABASE_SERVICE_KEY "SUPABASE_SERVICE_ROLE_KEY")

# Stripe
warn "--- Stripe ---"
STRIPE_PUB_KEY=$(prompt_value STRIPE_PUB_KEY "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (pk_live_... or pk_test_...)")
STRIPE_SECRET=$(prompt_secret STRIPE_SECRET "STRIPE_SECRET_KEY (sk_live_... or sk_test_...)")
STRIPE_PRICE_ID=$(prompt_value STRIPE_PRICE_ID "STRIPE_PRICE_ID (price_...)")

# App URL
warn "--- App ---"
APP_URL=$(prompt_value APP_URL "NEXT_PUBLIC_APP_URL (e.g. https://yourdomain.com)")

# Optional telemetry
warn "--- PostHog (optional, press Enter to skip) ---"
POSTHOG_KEY=$(prompt_value POSTHOG_KEY "NEXT_PUBLIC_POSTHOG_KEY (phc_...)")
POSTHOG_HOST=$(prompt_value POSTHOG_HOST "NEXT_PUBLIC_POSTHOG_HOST" "https://us.i.posthog.com")

warn "--- Sentry (optional, press Enter to skip) ---"
SENTRY_DSN=$(prompt_value SENTRY_DSN "NEXT_PUBLIC_SENTRY_DSN / SENTRY_DSN (https://...ingest.sentry.io/...)")

# ── Set env vars via Vercel CLI ──────────────────────────────────────────────
header "Setting Vercel environment variables (Production)"

set_env() {
  local key="$1"
  local val="$2"
  local env="${3:-production}"
  if [[ -z "$val" ]]; then
    warn "Skipping $key (empty)"
    return
  fi
  echo "$val" | vercel env add "$key" "$env" --force 2>/dev/null || \
    echo "$val" | vercel env add "$key" "$env"
  success "Set $key ($env)"
}

set_env "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"    "$CLERK_PUB_KEY"        "production"
set_env "CLERK_SECRET_KEY"                     "$CLERK_SECRET"         "production"
set_env "NEXT_PUBLIC_CLERK_SIGN_IN_URL"        "$CLERK_SIGN_IN_URL"    "production"
set_env "NEXT_PUBLIC_CLERK_SIGN_UP_URL"        "$CLERK_SIGN_UP_URL"    "production"
set_env "NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL"  "$CLERK_FALLBACK_SIGN_IN" "production"
set_env "NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL"  "$CLERK_FALLBACK_SIGN_UP" "production"
set_env "NEXT_PUBLIC_SUPABASE_URL"             "$SUPABASE_URL"         "production"
set_env "NEXT_PUBLIC_SUPABASE_ANON_KEY"        "$SUPABASE_ANON_KEY"    "production"
set_env "SUPABASE_SERVICE_ROLE_KEY"            "$SUPABASE_SERVICE_KEY" "production"
set_env "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"   "$STRIPE_PUB_KEY"       "production"
set_env "STRIPE_SECRET_KEY"                    "$STRIPE_SECRET"        "production"
set_env "STRIPE_PRICE_ID"                      "$STRIPE_PRICE_ID"      "production"
set_env "NEXT_PUBLIC_APP_URL"                  "$APP_URL"              "production"
set_env "NEXT_PUBLIC_POSTHOG_KEY"              "$POSTHOG_KEY"          "production"
set_env "NEXT_PUBLIC_POSTHOG_HOST"             "$POSTHOG_HOST"         "production"
set_env "NEXT_PUBLIC_SENTRY_DSN"               "$SENTRY_DSN"           "production"
set_env "SENTRY_DSN"                           "$SENTRY_DSN"           "production"

# Webhook secrets are set later — placeholders
echo "" | vercel env add "STRIPE_WEBHOOK_SECRET"      "production" --force 2>/dev/null || true
echo "" | vercel env add "CLERK_WEBHOOK_SIGNING_SECRET" "production" --force 2>/dev/null || true
warn "STRIPE_WEBHOOK_SECRET and CLERK_WEBHOOK_SIGNING_SECRET left blank — run setup-webhooks.sh after first deploy"

# ── Deploy staging ────────────────────────────────────────────────────────────
header "Deploying staging (develop branch)"

info "Ensuring develop branch exists and is pushed..."
if ! git show-ref --verify --quiet refs/heads/develop; then
  git checkout -b develop main
  git push -u origin develop
  success "Created and pushed develop branch"
else
  success "develop branch exists"
fi

info "Deploying staging preview..."
vercel deploy --target preview
success "Staging deployed"

# ── Deploy production ─────────────────────────────────────────────────────────
header "Deploying production (main branch)"

info "Deploying to production..."
vercel deploy --prod
success "Production deployed"

echo ""
success "setup-vercel.sh complete"
echo ""
warn "Remaining manual steps:"
echo "  1. Vercel Dashboard -> Settings -> Domains -> add stable alias for develop branch"
echo "     (e.g. staging-baseline.vercel.app)"
echo "  2. Run scripts/setup-webhooks.sh to register Stripe + Clerk webhooks"
echo "  3. Run scripts/setup-vercel.sh again (or update via Vercel Dashboard) to set webhook secrets"
echo "  4. Redeploy: vercel --prod"
