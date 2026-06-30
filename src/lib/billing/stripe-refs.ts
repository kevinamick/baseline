/**
 * Pure Stripe-payload field readers shared across the billing mirror seam — the
 * webhook event→mirror mapping (webhook.ts), the trust escalation helpers
 * (trust.ts), and the route's recency guard (api/webhooks/stripe/route.ts). Kept
 * free of I/O so the modules that import them stay unit-testable without Stripe.
 */

/**
 * The id behind a Stripe ref that may be a bare string id or an expanded object.
 * Stripe expands a relation to its full object when asked and leaves it as the id
 * string otherwise, so a reader must handle both shapes.
 */
export function stripeRefId(
  ref: string | { id: string } | null | undefined,
): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

/** A Stripe Unix-seconds timestamp as an ISO string, or null when absent. */
export function isoFromUnix(seconds: number | null | undefined): string | null {
  return typeof seconds === "number"
    ? new Date(seconds * 1000).toISOString()
    : null;
}
