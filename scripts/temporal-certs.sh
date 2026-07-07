#!/usr/bin/env bash
# Generate the Temporal Cloud mTLS certificates and set them on both sides
# (Vercel app env + Fly worker secrets).
#
# Temporal Cloud auth model: the namespace trusts a CA certificate you upload
# once; clients (the app's getTemporalClient() and the worker) present an
# end-entity cert signed by that CA. Both connection.ts files read the pair
# base64-encoded from TEMPORAL_TLS_CERT / TEMPORAL_TLS_KEY — presence flips
# mTLS on.
#
# Sets the full Temporal env on both sides — TEMPORAL_ADDRESS and
# TEMPORAL_NAMESPACE alongside the TLS pair (address derives from the
# namespace: <ns>.tmprl.cloud:7233, override with --address) — then triggers
# a Vercel redeploy of the latest deployment for the environment, since env
# is baked at deploy time.
#
# Usage:
#   scripts/temporal-certs.sh staging                  # full setup or client rotation
#   scripts/temporal-certs.sh prod --fly-app <app> --namespace <ns.acct>
#   scripts/temporal-certs.sh staging --rotate-ca      # new CA (re-upload to Temporal!)
#   scripts/temporal-certs.sh staging --rotate-encryption-key  # new codec key
#                                                      # (in-flight runs fail to decode!)
#   scripts/temporal-certs.sh staging --print-only     # generate + print, set nothing
#   scripts/temporal-certs.sh staging --no-deploy      # set env, skip the redeploy
#
# Also generates TEMPORAL_ENCRYPTION_KEY (AES-256-GCM payload codec, 32 bytes
# base64) on first run and reuses it after — both sides must share the same
# key, and rotating it orphans in-flight workflows' encrypted payloads, so
# rotation is a deliberate flag, never a side effect.
#
# Behavior:
#   * CA key/cert live in ~/.baseline/temporal-certs/<env>/ (chmod 700, never
#     in the repo). An existing CA is REUSED — re-running rotates only the
#     client cert, so nothing needs re-uploading to Temporal Cloud.
#   * --rotate-ca mints a fresh CA; the script then prints the upload
#     instructions, and the old client certs keep working until you remove
#     the old CA from the namespace.
#   * Vercel env is replaced (rm + add) in the right scope: staging → Preview,
#     prod → Production. Remember Vercel bakes env at deploy: REDEPLOY after.
#   * Fly secrets set triggers a worker restart on its own.
#
# Requirements: openssl, vercel CLI (logged in + project linked), flyctl
# (logged in). tcld is optional — the CA upload prints both the tcld command
# and the Cloud-UI path.

set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

ENV_NAME="${1:-}"; shift || true
[[ "$ENV_NAME" == "staging" || "$ENV_NAME" == "prod" ]] \
  || die "usage: scripts/temporal-certs.sh <staging|prod> [--fly-app <app>] [--namespace <ns>] [--rotate-ca] [--print-only]"

# Defaults per environment; prod's worker app has no default on purpose.
if [[ "$ENV_NAME" == "staging" ]]; then
  VERCEL_SCOPE="preview"
  FLY_APP="baseline-7e62lg"
  NAMESPACE="baseline-staging.bfwxl"
else
  VERCEL_SCOPE="production"
  FLY_APP=""
  NAMESPACE=""
fi

ROTATE_CA=false
ROTATE_ENC=false
PRINT_ONLY=false
DEPLOY=true
ADDRESS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fly-app)   FLY_APP="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --address)   ADDRESS="$2"; shift 2 ;;
    --rotate-ca) ROTATE_CA=true; shift ;;
    --rotate-encryption-key) ROTATE_ENC=true; shift ;;
    --print-only) PRINT_ONLY=true; shift ;;
    --no-deploy) DEPLOY=false; shift ;;
    *) die "unknown flag: $1" ;;
  esac
done
[[ -n "$ADDRESS" || -z "$NAMESPACE" ]] || ADDRESS="$NAMESPACE.tmprl.cloud:7233"

if ! $PRINT_ONLY; then
  [[ -n "$FLY_APP" ]]   || die "prod needs --fly-app <worker app name>"
  [[ -n "$NAMESPACE" ]] || die "prod needs --namespace <ns.account>"
fi

CA_DAYS="${CA_DAYS:-365}"
CERT_DAYS="${CERT_DAYS:-365}"
CERT_DIR="${TEMPORAL_CERT_DIR:-$HOME/.baseline/temporal-certs/$ENV_NAME}"
mkdir -p "$CERT_DIR"; chmod 700 "$CERT_DIR"
cd "$CERT_DIR"

# ── 1. CA (reused unless --rotate-ca) ────────────────────────────────────────
NEW_CA=false
if [[ ! -f ca.pem || ! -f ca.key ]] || $ROTATE_CA; then
  NEW_CA=true
  echo "==> Generating CA (${CA_DAYS}d) in $CERT_DIR"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -days "$CA_DAYS" \
    -keyout ca.key -out ca.pem \
    -subj "/CN=baseline-$ENV_NAME-temporal-ca" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  chmod 600 ca.key
else
  echo "==> Reusing existing CA in $CERT_DIR (--rotate-ca for a new one)"
  # Refuse to issue from a CA that is about to expire.
  openssl x509 -checkend $((30*24*3600)) -noout -in ca.pem >/dev/null \
    || die "CA expires within 30 days — run with --rotate-ca and re-upload"
fi

# ── 2. Client cert (always freshly issued) ───────────────────────────────────
echo "==> Issuing client cert (${CERT_DAYS}d)"
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout client.key -out client.csr \
  -subj "/CN=baseline-$ENV_NAME-client" 2>/dev/null
openssl x509 -req -in client.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -days "$CERT_DAYS" -out client.pem \
  -extfile <(printf "extendedKeyUsage=clientAuth\nkeyUsage=critical,digitalSignature") 2>/dev/null
chmod 600 client.key
rm -f client.csr

openssl verify -CAfile ca.pem client.pem >/dev/null || die "issued cert failed verification"
echo "    subject: $(openssl x509 -noout -subject -in client.pem | sed 's/subject=//')"
echo "    expires: $(openssl x509 -noout -enddate -in client.pem | sed 's/notAfter=//')"

CRT_B64=$(base64 -w0 < client.pem)
KEY_B64=$(base64 -w0 < client.key)

# ── 2b. Payload-codec encryption key (AES-256-GCM, 32 bytes base64) ─────────
# Reused across runs: rotating it makes every in-flight workflow's encrypted
# payloads undecodable, so rotation is opt-in and should only happen when no
# runs are active (or you accept failing them).
if [[ ! -f encryption.key ]] || $ROTATE_ENC; then
  if $ROTATE_ENC && [[ -f encryption.key ]]; then
    echo "==> ROTATING encryption key — in-flight workflows will fail to decode payloads"
  else
    echo "==> Generating payload encryption key"
  fi
  openssl rand -base64 32 > encryption.key
  chmod 600 encryption.key
else
  echo "==> Reusing existing encryption key (--rotate-encryption-key for a new one)"
fi
ENC_KEY=$(< encryption.key)

# ── 3. CA upload to Temporal Cloud (manual/one-time per CA) ─────────────────
if $NEW_CA; then
  cat <<EOF

==> NEW CA — register it on the Temporal Cloud namespace (one-time):
    Cloud UI: cloud.temporal.io → Namespaces → $NAMESPACE → Edit → CA Certificates
      (paste $CERT_DIR/ca.pem; keep the old CA listed until clients rotate)
    or tcld:  tcld namespace accepted-client-ca add \\
                --namespace "$NAMESPACE" --ca-certificate-file "$CERT_DIR/ca.pem"

EOF
fi

if $PRINT_ONLY; then
  echo "==> --print-only: set these yourself (base64 of the PEMs):"
  echo "TEMPORAL_ADDRESS=$ADDRESS"
  echo "TEMPORAL_NAMESPACE=$NAMESPACE"
  echo "TEMPORAL_TLS_CERT=$CRT_B64"
  echo "TEMPORAL_TLS_KEY=<in $CERT_DIR/client.key — not printed>"
  echo "TEMPORAL_ENCRYPTION_KEY=<in $CERT_DIR/encryption.key — not printed>"
  exit 0
fi

# ── 4. Vercel (app side): address, namespace, and the TLS pair ──────────────
echo "==> Setting Vercel env ($VERCEL_SCOPE scope)"
for pair in \
  "TEMPORAL_ADDRESS:$ADDRESS" \
  "TEMPORAL_NAMESPACE:$NAMESPACE" \
  "TEMPORAL_TLS_CERT:$CRT_B64" \
  "TEMPORAL_TLS_KEY:$KEY_B64" \
  "TEMPORAL_ENCRYPTION_KEY:$ENC_KEY"; do
  name="${pair%%:*}"; value="${pair#*:}"
  vercel env rm "$name" "$VERCEL_SCOPE" --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$name" "$VERCEL_SCOPE" --sensitive >/dev/null
  echo "    $name set"
done

# ── 5. Fly (worker side) ─────────────────────────────────────────────────────
echo "==> Setting Fly secrets on $FLY_APP (restarts the machine)"
flyctl secrets set -a "$FLY_APP" \
  "TEMPORAL_ADDRESS=$ADDRESS" \
  "TEMPORAL_NAMESPACE=$NAMESPACE" \
  "TEMPORAL_TLS_CERT=$CRT_B64" \
  "TEMPORAL_TLS_KEY=$KEY_B64" \
  "TEMPORAL_ENCRYPTION_KEY=$ENC_KEY" >/dev/null
echo "    secrets set"

# ── 6. Vercel redeploy (env is baked at deploy time) ────────────────────────
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

==> Done. Remaining steps:
    1. $( $NEW_CA && echo "Upload the CA above to Temporal Cloud FIRST — clients fail until it lands." || echo "CA unchanged — nothing to upload." )
    2. Verify by behavior (Sensitive vars can't be read back):
       worker side: temporal task-queue describe shows pollers;
       app side:    start an eval run.
EOF
