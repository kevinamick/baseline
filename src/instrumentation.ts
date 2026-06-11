import * as Sentry from "@sentry/nextjs";

export async function register() {
  // PostHog Logs: register the global OTel LoggerProvider (nodejs runtime only — the OTLP
  // HTTP exporter is Node-flavored, and src/lib/logging/server.ts is server-only anyway).
  // Dynamic import keeps the OTel SDK out of the edge instrumentation bundle.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerLogging } = await import("@/lib/logging/otel");
    registerLogging();
  }

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init({
      dsn,
      tracesSampleRate: 0.1,
      environment:
        process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
      release: process.env.VERCEL_GIT_COMMIT_SHA,
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn,
      tracesSampleRate: 0.1,
      environment:
        process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
      release: process.env.VERCEL_GIT_COMMIT_SHA,
    });
  }
}

export const onRequestError = Sentry.captureRequestError;
