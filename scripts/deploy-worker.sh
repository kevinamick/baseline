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
  local prompt_text="$1"
  local value=""
  read -rsp "$(echo -e "${CYAN}?${RESET} $prompt_text: ")" value
  echo ""
  printf '%s' "$value"
}

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_DIR="$REPO_ROOT/worker"

# ── Prerequisites ────────────────────────────────────────────────────────────
header "Checking prerequisites"

if ! command -v fly &>/dev/null; then
  error "Fly CLI not found."
  echo "  Install: curl -L https://fly.io/install.sh | sh"
  echo "  Then:    fly auth login"
  exit 1
fi
success "fly CLI found ($(fly version 2>/dev/null | head -1))"

if ! fly auth whoami &>/dev/null; then
  info "Not logged in to Fly. Running 'fly auth login'..."
  fly auth login
fi
success "Logged in to Fly as $(fly auth whoami)"

if [[ ! -d "$WORKER_DIR" ]]; then
  error "worker/ directory not found at $WORKER_DIR"
  exit 1
fi
success "worker/ directory found"

# ── Determine app name ───────────────────────────────────────────────────────
header "Fly app setup"

FLY_TOML="$WORKER_DIR/fly.toml"
if [[ -f "$FLY_TOML" ]]; then
  APP_NAME=$(grep '^app\s*=' "$FLY_TOML" | head -1 | sed "s/app\s*=\s*['\"]//;s/['\"]//")
  success "fly.toml found, app name: $APP_NAME"
else
  APP_NAME=$(prompt_value "Fly app name" "baseline-eval-worker")
fi

# Check if the app already exists
if fly apps list 2>/dev/null | grep -q "^${APP_NAME}"; then
  success "Fly app '$APP_NAME' already exists"
else
  info "Creating Fly app '$APP_NAME'..."
  cd "$WORKER_DIR"
  fly launch --no-deploy --name "$APP_NAME" || true
  success "Fly app created"
fi

# ── Collect secrets ──────────────────────────────────────────────────────────
header "Collecting Fly secrets"

echo "These values are stored encrypted in Fly and never in fly.toml."
echo ""

SUPABASE_URL=$(prompt_value "SUPABASE_URL (https://<ref>.supabase.co)")
SUPABASE_SERVICE_KEY=$(prompt_secret "SUPABASE_SERVICE_ROLE_KEY")
ANTHROPIC_API_KEY=$(prompt_secret "ANTHROPIC_API_KEY (sk-ant-...)")
RESEND_API_KEY=$(prompt_secret "RESEND_API_KEY (re_...)")
RESEND_FROM=$(prompt_value "RESEND_FROM (e.g. evals@yourdomain.com)")
APP_URL=$(prompt_value "APP_URL (e.g. https://yourdomain.com)")

# ── Set secrets ──────────────────────────────────────────────────────────────
header "Setting Fly secrets"

cd "$WORKER_DIR"
fly secrets set \
  SUPABASE_URL="$SUPABASE_URL" \
  SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_KEY" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  RESEND_API_KEY="$RESEND_API_KEY" \
  RESEND_FROM="$RESEND_FROM" \
  APP_URL="$APP_URL"

success "Secrets set"

# ── Deploy ───────────────────────────────────────────────────────────────────
header "Deploying worker"

info "Running fly deploy from $WORKER_DIR..."
fly deploy
success "Worker deployed"

echo ""
info "Streaming recent logs (Ctrl+C to exit)..."
fly logs --no-tail 2>/dev/null || true

echo ""
success "deploy-worker.sh complete"
echo ""
warn "Useful commands:"
echo "  fly logs                  # stream live logs"
echo "  fly status                # check machine health"
echo "  fly scale count 2         # run 2 workers in parallel"
echo "  cd worker && fly deploy   # redeploy after worker/ changes"
