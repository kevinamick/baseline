#!/usr/bin/env bash
set -euo pipefail

# Master bootstrap script — calls all deployment sub-scripts in order.
# Run from the repo root:
#   bash scripts/bootstrap.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
GREEN="\033[1;32m"
YELLOW="\033[1;33m"
CYAN="\033[1;36m"
BOLD="\033[1m"
RESET="\033[0m"

info()    { echo -e "${CYAN}▸${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET} $*"; }
banner()  {
  echo -e ""
  echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${RESET}"
  printf   "${BOLD}║  %-52s  ║${RESET}\n" "$*"
  echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${RESET}"
  echo -e ""
}
section() {
  echo -e ""
  echo -e "${BOLD}┌──────────────────────────────────────────────────────┐${RESET}"
  printf   "${BOLD}│  %-52s  │${RESET}\n" "$*"
  echo -e "${BOLD}└──────────────────────────────────────────────────────┘${RESET}"
  echo -e ""
}

banner "Baseline — Full Deployment Bootstrap"

echo "This script runs the following sub-scripts in order:"
echo "  1. scripts/setup-supabase.sh  — link Supabase projects + apply migrations"
echo "  2. scripts/setup-vercel.sh    — link Vercel, set env vars, deploy staging + prod"
echo "  3. scripts/deploy-worker.sh   — deploy the Fly.io eval worker"
echo "  4. scripts/setup-webhooks.sh  — register Stripe + Clerk webhooks"
echo ""
echo "You can also run each script individually if you only need one step."
echo ""
warn "Prerequisites: supabase CLI, vercel CLI, gh CLI, fly CLI must all be installed."
echo ""
read -rp "$(echo -e "${CYAN}?${RESET} Continue with full bootstrap? (y/N): ")" CONFIRM
if [[ "${CONFIRM,,}" != "y" ]]; then
  echo "Aborted."
  exit 0
fi

# ── Step 1: Supabase ─────────────────────────────────────────────────────────
section "Step 1/4 — Supabase"
bash "$SCRIPT_DIR/setup-supabase.sh"
success "Supabase setup complete"

# ── Step 2: Vercel ───────────────────────────────────────────────────────────
section "Step 2/4 — Vercel"
bash "$SCRIPT_DIR/setup-vercel.sh"
success "Vercel setup complete"

# ── Step 3: Fly.io eval worker ───────────────────────────────────────────────
section "Step 3/4 — Fly.io Eval Worker"
bash "$SCRIPT_DIR/deploy-worker.sh"
success "Fly.io worker deployed"

# ── Step 4: Webhooks ─────────────────────────────────────────────────────────
section "Step 4/4 — Webhooks (Stripe + Clerk)"
bash "$SCRIPT_DIR/setup-webhooks.sh"
success "Webhook setup complete"

# ── Done ─────────────────────────────────────────────────────────────────────
banner "Bootstrap Complete"

echo "All steps finished. Final checklist:"
echo ""
echo "  ${GREEN}✓${RESET} Supabase staging + prod projects linked and migrated"
echo "  ${GREEN}✓${RESET} Vercel project linked with env vars set"
echo "  ${GREEN}✓${RESET} Staging and production deployed to Vercel"
echo "  ${GREEN}✓${RESET} Fly.io eval worker deployed"
echo "  ${GREEN}✓${RESET} Webhook endpoints registered"
echo ""
warn "Manual steps still required:"
echo "  • Vercel Dashboard → Settings → Domains → add stable staging alias"
echo "    for the develop branch (e.g. staging-baseline.vercel.app)"
echo "  • Set webhook secrets in Vercel env vars (STRIPE_WEBHOOK_SECRET,"
echo "    CLERK_WEBHOOK_SIGNING_SECRET) then redeploy: vercel --prod"
echo "  • Add GitHub Actions secrets (SUPABASE_ACCESS_TOKEN,"
echo "    SUPABASE_PROJECT_ID_PROD, SUPABASE_DB_PASSWORD_PROD)"
echo "  • Enable branch protection on main + develop in GitHub Settings"
echo ""
