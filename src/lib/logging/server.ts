// Structured server-side logging → PostHog Logs (issue #38).
//
// Every call mirrors to the real console (so local DX, Vercel log streams, and existing
// `vi.spyOn(console, ...)` test assertions keep working) and, when PostHog is configured,
// also emits an OTel log record through the global LoggerProvider registered by
// `src/instrumentation.ts` (see src/lib/logging/otel.ts). Console functions are looked up
// at CALL time, not import time, so the mirror always hits whatever Sentry (or a test)
// has patched onto `console` by the time the log fires.
//
// Serverless contract, bounded: server actions / route handlers can freeze right after
// responding, so warn/error calls await a forceFlush of the provider — but the wait is
// capped at FLUSH_WAIT_MS (and the exporter itself at 2s, see otel.ts) so a PostHog
// outage can never add multi-second latency to a request. info logs flush best-effort
// without being awaited: they're emitted and the flush is kicked off, but the request
// never waits on it. Same rationale as the awaited `flush()` in src/lib/analytics/server.ts.
//
// Attribute flattening lives in worker/src/log-attributes.ts — the cross-service contract
// shared with the worker logger (worker/src/log.ts). Fix flattening there, never here.
//
// Logging is strictly best-effort: it never throws and never rejects, no matter what
// PostHog is doing.

import "server-only";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
  flattenAttributes,
  type LogAttributes,
  type LogLevel,
} from "../../../worker/src/log-attributes";

export { LOG_LEVELS, type LogLevel, type LogAttributes } from "../../../worker/src/log-attributes";

// Upper bound on how long a warn/error call may wait for the flush. The export keeps
// running in the background past this cap; we just stop holding the request hostage.
const FLUSH_WAIT_MS = 1000;

const SEVERITY_NUMBER: Record<LogLevel, SeverityNumber> = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

// Late-bound on purpose (see module header).
const CONSOLE_FN: Record<LogLevel, (...args: unknown[]) => void> = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

function flushWaitCap(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FLUSH_WAIT_MS) as unknown as { unref?: () => void };
    timer.unref?.(); // don't keep the process alive just for the cap
  });
}

async function emit(level: LogLevel, message: string, attributes?: LogAttributes): Promise<void> {
  // 1. Console mirror — always, and first, so it happens even if the OTel path breaks.
  try {
    if (attributes !== undefined) CONSOLE_FN[level](message, attributes);
    else CONSOLE_FN[level](message);
  } catch {
    // never throw from a log call
  }

  // 2. PostHog emit — no-op without the key (graceful degradation, like analytics/server.ts).
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
  try {
    logs.getLogger("baseline-app").emit({
      severityNumber: SEVERITY_NUMBER[level],
      severityText: level.toUpperCase(),
      body: message,
      attributes: attributes ? flattenAttributes(attributes) : undefined,
    });

    // Flush so records ship before a serverless runtime can freeze. The global provider
    // is the SDK LoggerProvider registered in instrumentation; duck-type forceFlush
    // because the api-logs interface (and the unregistered proxy/noop fallbacks) don't
    // carry it. info: fire-and-forget. warn/error: awaited, capped at FLUSH_WAIT_MS.
    const provider = logs.getLoggerProvider() as { forceFlush?: () => Promise<void> };
    if (typeof provider.forceFlush === "function") {
      const flushed = provider.forceFlush().catch(() => {});
      if (level !== "info") await Promise.race([flushed, flushWaitCap()]);
    }
  } catch {
    // best-effort: never reject or block a request on PostHog being down
  }
}

export const log = {
  info: (message: string, attributes?: LogAttributes) => emit("info", message, attributes),
  warn: (message: string, attributes?: LogAttributes) => emit("warn", message, attributes),
  error: (message: string, attributes?: LogAttributes) => emit("error", message, attributes),
};
