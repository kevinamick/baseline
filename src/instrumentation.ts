import type { Instrumentation } from "next";

export async function register() {
  // PostHog Logs: register the global OTel LoggerProvider (nodejs runtime only — the OTLP
  // HTTP exporter is Node-flavored, and src/lib/logging/server.ts is server-only anyway).
  // Dynamic import keeps the OTel SDK out of the edge instrumentation bundle.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerLogging } = await import("@/lib/logging/otel");
    registerLogging();
  }
}

// Server-side error tracking → PostHog (#166). Only the Node runtime path reports:
// posthog-node is Node-flavored and src/lib/analytics/server.ts is server-only, so
// the dynamic import stays out of the edge bundle. The distinct_id comes from the
// visitor's posthog-js cookie when present, tying the server error to their session.
//
// The same error is also emitted to PostHog Logs as a structured `error` record so it
// lands in the queryable log stream alongside the request's other logs — correlated by
// the `request_id` the proxy minted (read off the request headers, since this hook runs
// outside the request scope the app logger auto-reads from), plus the failing route's
// path/method/type. Error tracking and Logs are distinct PostHog products; carrying the
// error into both means a request_id pivots from a log line straight to its other logs.
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context
) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const [{ captureException, distinctIdFromCookie }, { log }] = await Promise.all([
    import("@/lib/analytics/server"),
    import("@/lib/logging/server"),
  ]);

  const header = request.headers["x-request-id"];
  const requestId = Array.isArray(header) ? header[0] : header;
  await log.error("Unhandled server error", {
    // Explicit request_id wins over the logger's auto-stamp, which can't read
    // next/headers from here. undefined entries are dropped by flattenAttributes.
    request_id: requestId,
    path: request.path,
    method: request.method,
    route_path: context.routePath,
    route_type: context.routeType,
    // The `error` key gets special flattening: an Error becomes error_message +
    // error_stack, a Supabase/Postgres-style object keeps its whitelisted fields.
    error,
  });

  const distinctId = distinctIdFromCookie(request.headers.cookie) ?? "anonymous";
  await captureException(error, distinctId);
};
