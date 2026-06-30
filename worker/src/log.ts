// Structured logging → PostHog Logs for the worker (issue #38).
//
// PostHog ingests logs over OTLP: an HTTP exporter pointed at `<POSTHOG_HOST>/i/v1/logs`,
// authenticated with the same POSTHOG_KEY the events layer (telemetry.ts) uses. The worker
// is a long-running process, so a BatchLogRecordProcessor with periodic export is fine —
// no per-call flush needed; `shutdownLogging()` drains the buffer on the way out.
//
// Every call also mirrors to the real console (error→console.error, warn→console.warn,
// info→console.log) so Fly log streams and the existing `vi.spyOn(console, ...)` test
// assertions keep working. Console functions are looked up at CALL time, not import time,
// so the mirror always hits whatever (a test, or any other instrumentation) has patched
// onto `console` by the time the log fires.
//
// Attribute flattening lives in ./log-attributes.ts — the cross-service contract shared
// with the app logger (src/lib/logging/server.ts). Fix flattening there, never here.
//
// Run correlation: every PostHog record is auto-stamped with the ambient run's `run_id` and
// `org_id` from the AsyncLocalStorage scope opened around processing a run (./log-context.ts),
// so logs from deep call sites (provider clients, the evaluator) correlate to their run with
// no signature threading. The console mirror is left untouched so existing console-spy
// assertions keep matching byte-for-byte; correlation lives on the OTel record where it's
// queryable. An explicit `run_id`/`org_id` in the call's attributes wins over the ambient one.
//
// Logging is strictly best-effort: it never throws.

import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { flattenAttributes, type LogAttributes, type LogLevel } from "./log-attributes.js";
import { currentLogContext } from "./log-context.js";

export { LOG_LEVELS, type LogLevel, type LogAttributes } from "./log-attributes.js";

const SEVERITY_NUMBER: Record<LogLevel, SeverityNumber> = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

// Late-bound on purpose (see module header): resolve console.* at call time so the
// mirror always hits whatever is patched onto `console` when the log fires, not whatever
// happened to be there at import time.
const CONSOLE_FN: Record<LogLevel, (...args: unknown[]) => void> = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

let provider: LoggerProvider | null = null;

// Create the LoggerProvider. Called from initTelemetry() (worker/src/telemetry.ts).
// No-op (graceful degradation, same contract as the events client there) without POSTHOG_KEY.
export function initLogging(): void {
  const key = process.env.POSTHOG_KEY;
  if (!key || provider) return;

  const host = (process.env.POSTHOG_HOST ?? "https://us.i.posthog.com").replace(/\/+$/, "");
  const release = process.env.VERCEL_GIT_COMMIT_SHA;
  provider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": "baseline-worker",
      env: process.env.NODE_ENV ?? "development",
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
          // Bound each export attempt: the otlp-exporter-base default is 10s, which
          // would pin batches (and shutdownLogging) on a PostHog brown-out.
          timeoutMillis: 2000,
        })
      ),
    ],
  });
}

// Flush buffered records and shut the provider down. Called from the worker's
// SIGINT/SIGTERM path; never throws (shutdown must not be blocked by PostHog).
export async function shutdownLogging(): Promise<void> {
  const p = provider;
  provider = null;
  if (!p) return;
  try {
    await p.shutdown();
  } catch {
    // best-effort
  }
}

function getLogger(): Logger | null {
  return provider ? provider.getLogger("baseline-worker") : null;
}

function emit(level: LogLevel, message: string, attributes?: LogAttributes): void {
  // 1. Console mirror — always, and first, so it happens even if the OTel path breaks.
  try {
    if (attributes !== undefined) CONSOLE_FN[level](message, attributes);
    else CONSOLE_FN[level](message);
  } catch {
    // never throw from a log call
  }

  // 2. PostHog emit — no-op until initLogging() ran with a POSTHOG_KEY.
  try {
    const logger = getLogger();
    if (!logger) return;
    const flat = attributes ? flattenAttributes(attributes) : {};
    // Stamp the ambient run identity unless the caller passed it explicitly (caller wins).
    const ctx = currentLogContext();
    if (ctx) {
      if (ctx.run_id !== undefined && flat.run_id === undefined) flat.run_id = ctx.run_id;
      if (ctx.org_id !== undefined && flat.org_id === undefined) flat.org_id = ctx.org_id;
    }
    logger.emit({
      severityNumber: SEVERITY_NUMBER[level],
      severityText: level.toUpperCase(),
      body: message,
      attributes: Object.keys(flat).length > 0 ? flat : undefined,
    });
  } catch {
    // best-effort: a logging failure must never affect the worker
  }
}

export const log = {
  info: (message: string, attributes?: LogAttributes) => emit("info", message, attributes),
  warn: (message: string, attributes?: LogAttributes) => emit("warn", message, attributes),
  error: (message: string, attributes?: LogAttributes) => emit("error", message, attributes),
};
