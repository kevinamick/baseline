// OTel LoggerProvider wiring for PostHog Logs (issue #38).
//
// PostHog ingests logs over OTLP: an HTTP exporter pointed at `<host>/i/v1/logs`,
// authenticated with the same project token the events layer uses. This module is
// imported (dynamically) from `src/instrumentation.ts` under the nodejs runtime only —
// keep it free of `server-only` so the instrumentation bundle can load it.
//
// The provider is registered through the global `logs` API (a `Symbol.for` keyed slot on
// globalThis), so server-action/route bundles — which webpack compiles separately from the
// instrumentation bundle — still reach the same provider via `logs.getLoggerProvider()`.

import { logs } from "@opentelemetry/api-logs";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";

// Registers the global LoggerProvider. No-op (graceful degradation, same contract as
// src/lib/analytics/server.ts) when the PostHog key is absent.
export function registerLogging(): void {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;

  const host = (
    process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com"
  ).replace(/\/+$/, "");

  const release = process.env.VERCEL_GIT_COMMIT_SHA;
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": "baseline-app",
      env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
      ...(release ? { release } : {}),
    }),
    processors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({
          url: `${host}/i/v1/logs`,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
        })
      ),
    ],
  });

  // setGlobalLoggerProvider is first-write-wins; re-registration is a no-op.
  logs.setGlobalLoggerProvider(provider);
}
