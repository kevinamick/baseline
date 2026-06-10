// OTel log-record processor for PostHog Logs (issue #38).
//
// PostHog ingests logs over OTLP: an HTTP exporter pointed at `<host>/i/v1/logs`,
// authenticated with the same project token the events layer uses. The processor built
// here is handed to `registerOTel()` in `src/instrumentation.ts`, which owns the global
// LoggerProvider registration (via the @opentelemetry/api-logs global registry — the
// same one `src/lib/logging/server.ts` reads through `logs.getLogger(...)`). This module
// is imported (dynamically) under the nodejs runtime only — the OTLP HTTP exporter is
// Node-flavored — so keep it free of `server-only`.

import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";

// Builds the PostHog log-record processor. Returns null (graceful degradation, same
// contract as src/lib/analytics/server.ts) when the PostHog key is absent — the caller
// then registers OTel with no log processors.
export function posthogLogRecordProcessor(): LogRecordProcessor | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;

  const host = (
    process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com"
  ).replace(/\/+$/, "");

  return new BatchLogRecordProcessor(
    new OTLPLogExporter({
      url: `${host}/i/v1/logs`,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      // Bound each export attempt: the otlp-exporter-base default is 10s, which a
      // per-request forceFlush (src/lib/logging/server.ts) would otherwise inherit
      // whenever PostHog hangs rather than refuses.
      timeoutMillis: 2000,
    })
  );
}
