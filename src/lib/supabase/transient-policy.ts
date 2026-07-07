// The single transient-failure retry policy (ADR-0018,
// docs/adr/0018-transient-retry-at-data-access-seam.md), shared by every seam that
// retries a transport blip: `retrying-fetch.ts` (the server-side Supabase HTTP
// clients) and `rpc.ts`'s `readRpcOrThrow` (opt-in read-only RPC retries). One
// retry, 150ms flat delay, transient = 502/503/504 or a network-level rejection.
// Deliberately NOT retried: 429 (the rate limiter speaking — retrying defeats it),
// 500 (as often a real bug as a blip), and timeouts/hangs. Edit this file to change
// the policy anywhere — never re-declare these constants at a call site
// (single-source rule).

/** How many times a transient failure is retried, after the initial attempt. */
export const TRANSIENT_RETRY_ATTEMPTS = 1;

/** Flat delay before the retry attempt. No backoff — see the ADR for why. */
export const TRANSIENT_RETRY_DELAY_MS = 150;

/** The gateway status codes considered transient (Kong/PostgREST 5xx blips). */
export const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([502, 503, 504]);

/** True for a response status this policy considers a transient gateway blip. */
export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUS_CODES.has(status);
}

// Matches the Kong<->PostgREST keep-alive connection-reuse race ("upstream
// prematurely closed connection...", "invalid response... from the upstream
// server") and the equivalent hosted-gateway 502/503/504 class surfaced as an RPC
// error *message* (RPCs have no HTTP status to inspect at the call site) — a
// transport blip, not a data or constraint error. Consumed by `readRpcOrThrow`.
export const TRANSIENT_RPC_ERROR_PATTERN = /upstream|gateway|\b50[234]\b/i;
