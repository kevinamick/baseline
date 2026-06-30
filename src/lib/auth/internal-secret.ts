import "server-only";
import { log } from "@/lib/logging/server";

/**
 * Shared bearer-secret gate for the internal cron/worker-triggered routes under
 * `/api/internal/*` (retention sweep, managed-threshold sweep, claim-reserve).
 * Each is authenticated by a per-route shared secret the cron/worker config
 * carries, and fails closed: no secret configured → 503, wrong/absent header →
 * 401.
 *
 * Returns a ready-to-return `Response` to short-circuit the handler, or `null`
 * when the request is authorized and the caller should proceed:
 *
 * ```ts
 * const denied = requireInternalSecret(req, "RETENTION_SECRET", "billing.retention");
 * if (denied) return denied;
 * ```
 *
 * Both refusal paths used to be silent. A rotated-but-not-redeployed secret (401)
 * or a missing env var after a deploy (503) would kill a billing sweep with no
 * queryable trace — exactly the kind of background-job failure observability is
 * for. Each refusal now emits a structured `warn` log keyed by `route`. Logging
 * is fire-and-forget (`void log.warn`) because this path is reachable by any
 * unauthenticated POST, so it must never buy a caller a synchronous PostHog
 * round-trip per request — mirroring the Stripe webhook's signature-invalid path.
 */
export function requireInternalSecret(
  req: Request,
  envVar: string,
  route: string
): Response | null {
  const secret = process.env[envVar];
  if (!secret) {
    void log.warn("internal route secret not configured — failing closed", {
      event: "internal_route.secret_not_configured",
      route,
      env_var: envVar,
    });
    return new Response("Not configured", { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    void log.warn("internal route auth rejected", {
      event: "internal_route.unauthorized",
      route,
    });
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}
