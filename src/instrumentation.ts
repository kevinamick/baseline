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
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request
) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { captureException, distinctIdFromCookie } = await import(
    "@/lib/analytics/server"
  );
  const distinctId = distinctIdFromCookie(request.headers.cookie) ?? "anonymous";
  await captureException(error, distinctId);
};
