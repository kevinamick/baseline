// The single retrying-`fetch` definition (ADR-0018,
// docs/adr/0018-transient-retry-at-data-access-seam.md) injected into every
// server-side Supabase client (admin.ts, server.ts, route-client.ts,
// middleware.ts). Built on the zero-dependency `fetch-retry` package, which
// supplies the retry loop; this module supplies the gate (GET/HEAD only), the
// classifier, and the structured log.
//
// PostgREST expresses every table read as GET/HEAD and every write as
// POST/PATCH/DELETE, so gating on the HTTP method is a structural safety
// boundary, not a call-site convention: GoTrue auth traffic (POST) and every
// PostgREST/RPC write pass through completely untouched — not merely
// "declined a retry", but never routed through the retry wrapper at all, so
// there is zero behavioral surface added to non-GET/HEAD requests.
//
// The transient policy itself (status set, delay, attempt count) is NOT
// declared here — it lives in `transient-policy.ts`, shared with
// `rpc.ts`'s `readRpcOrThrow` classifier (single-source rule, ADR-0018).

import "server-only";
import fetchRetry from "fetch-retry";
import { log } from "@/lib/logging/server";
import {
  TRANSIENT_RETRY_ATTEMPTS,
  TRANSIENT_RETRY_DELAY_MS,
  isTransientStatus,
} from "@/lib/supabase/transient-policy";

type Fetch = typeof fetch;

const RETRIABLE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

// Mirrors the Fetch spec's own default: a request with no explicit method
// (neither `init.method` nor a `Request` object carrying one) is a GET.
function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method.toUpperCase();
  }
  return "GET";
}

/**
 * Wraps a fetch implementation with the ADR-0018 transient-retry policy.
 *
 * GET/HEAD requests are retried once, after a flat delay, when the request
 * rejects at the network level or resolves with a transient gateway status
 * (502/503/504). A second consecutive failure propagates unchanged — no
 * wrapping, no re-thrown/synthesized error. Every other method bypasses the
 * retry machinery entirely and calls `baseFetch` directly, so it is provably
 * invoked exactly once no matter what it returns.
 *
 * `baseFetch` defaults to the global `fetch` so each client only needs
 * `createRetryingFetch()`; the parameter exists for tests to inject a mock.
 */
export function createRetryingFetch(baseFetch: Fetch = fetch): Fetch {
  const retryableFetch = fetchRetry(baseFetch);

  return function retryingFetch(input: RequestInfo | URL, init?: RequestInit) {
    const method = methodOf(input, init);
    if (!RETRIABLE_METHODS.has(method)) {
      return baseFetch(input, init);
    }

    return retryableFetch(input, {
      ...init,
      retries: TRANSIENT_RETRY_ATTEMPTS,
      retryDelay: TRANSIENT_RETRY_DELAY_MS,
      retryOn: (attempt: number, error: Error | null, response: Response | null) => {
        if (attempt >= TRANSIENT_RETRY_ATTEMPTS) return false;
        const transient = error !== null || (response !== null && isTransientStatus(response.status));
        if (transient) {
          // Fire-and-forget: never let the (best-effort, flush-awaiting) log
          // call add latency on top of the retry delay itself.
          void log.warn("supabase: retrying transient read failure", {
            method,
            attempt: attempt + 1,
            status: response?.status,
            error_class: error?.name,
          });
        }
        return transient;
      },
    }) as ReturnType<Fetch>;
  };
}

/** The default retrying fetch, wrapping the global `fetch`. */
export const retryingFetch: Fetch = createRetryingFetch();
