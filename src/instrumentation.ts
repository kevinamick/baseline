import { registerOTel } from "@vercel/otel";
import type { Instrumentation } from "next";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";

export async function register() {
  // PostHog Logs: build the OTLP log processor on the nodejs runtime only — the OTLP
  // HTTP exporter is Node-flavored, and src/lib/logging/server.ts (the only emitter)
  // is server-only anyway. The dynamic import keeps the exporter out of the edge
  // instrumentation bundle; registerOTel itself runs on both runtimes.
  const logRecordProcessors: LogRecordProcessor[] = [];
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { posthogLogRecordProcessor } = await import("@/lib/logging/otel");
    const processor = posthogLogRecordProcessor();
    if (processor) logRecordProcessors.push(processor);
  }

  const release = process.env.VERCEL_GIT_COMMIT_SHA;
  registerOTel({
    serviceName: "baseline-app",
    // registerOTel auto-detects the Vercel attributes (env, vercel.sha, …) when
    // deployed; pin env/release explicitly so local and self-hosted node servers
    // stay queryable by the same attributes.
    attributes: {
      env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
      ...(release ? { release } : {}),
    },
    logRecordProcessors,
  });
}

// Server-error capture → PostHog error tracking (issue #166). Client-side errors are
// covered by posthog-js (`capture_exceptions: true` in src/instrumentation-client.ts);
// this hook covers App Router server errors (render, route handlers, server actions).
export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request
) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getPostHogServer } = await import("@/lib/analytics/posthog-server");
  const posthog = getPostHogServer();
  if (!posthog) return;

  const { distinctIdFromCookieHeader } = await import(
    "@/lib/analytics/posthog-cookie"
  );
  const distinctId = distinctIdFromCookieHeader(request.headers.cookie);

  posthog.captureException(err, distinctId ?? undefined);

  // Serverless contract, bounded (house style — see src/lib/logging/server.ts): await
  // the flush so the event ships before the runtime can freeze, but never let a
  // PostHog outage hold the error path hostage.
  await Promise.race([
    posthog.flush().catch(() => {}),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000) as unknown as { unref?: () => void };
      timer.unref?.();
    }),
  ]);
};
