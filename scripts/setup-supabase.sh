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

# ── Prerequisites ────────────────────────────────────────────────────────────
header "Checking prerequisites"

if ! command -v supabase &>/dev/null; then
  error "supabase CLI not found."
  echo "  Install: brew install supabase/tap/supabase"
  echo "       or: npm i -g supabase"
  exit 1
fi
success "supabase CLI found ($(supabase --version 2>/dev/null | head -1))"

# ── Staging project ──────────────────────────────────────────────────────────
header "Supabase — Staging project"

STAGING_REF="${SUPABASE_STAGING_REF:-}"
if [[ -z "$STAGING_REF" ]]; then
  read -rp "$(echo -e "${CYAN}?${RESET} Staging project ref (from dashboard URL, e.g. rtvcpeiabmdnbzhuafrk): ")" STAGING_REF
fi

info "Linking to staging project: $STAGING_REF"
supabase link --project-ref "$STAGING_REF"
success "Linked to staging"

info "Applying migrations to staging (supabase db push)..."
supabase db push
success "Staging migrations applied"

echo ""
warn "Verify in Supabase Studio -> Table Editor:"
echo "  * 'users' and 'customers' tables exist"
echo "  * Both have RLS enabled"

# ── Production project ───────────────────────────────────────────────────────
header "Supabase — Production project"

echo "If you don't have a prod project yet:"
echo "  1. Supabase Dashboard -> New Project (same region as staging)"
echo "  2. Save the project ref and DB password"
echo ""

PROD_REF="${SUPABASE_PROD_REF:-}"
if [[ -z "$PROD_REF" ]]; then
  read -rp "$(echo -e "${CYAN}?${RESET} Production project ref (leave blank to skip): ")" PROD_REF
fi

if [[ -n "$PROD_REF" ]]; then
  info "Linking to production project: $PROD_REF"
  supabase link --project-ref "$PROD_REF"
  success "Linked to prod"

  info "Applying migrations to prod (supabase db push)..."
  supabase db push
  success "Prod migrations applied"

  echo ""
  success "Both Supabase projects are ready."
  echo ""
  warn "Next steps (GitHub Actions secrets to add):"
  echo "  * SUPABASE_PROJECT_ID_PROD=$PROD_REF"
  echo "  * SUPABASE_DB_PASSWORD_PROD  (Supabase -> prod -> Settings -> Database -> connection password)"
  echo "  * SUPABASE_ACCESS_TOKEN      (Supabase -> Account -> Access Tokens -> Generate)"
  echo ""
  warn "Copy these from the prod Supabase project into Vercel's Production environment:"
  echo "  * NEXT_PUBLIC_SUPABASE_URL"
  echo "  * NEXT_PUBLIC_SUPABASE_ANON_KEY"
  echo "  * SUPABASE_SERVICE_ROLE_KEY"
else
  warn "Skipped production project setup."
fi

echo ""
success "setup-supabase.sh complete"
