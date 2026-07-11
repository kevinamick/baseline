// Structured server-side logging → PostHog Logs (issue #38).
//
// Every call mirrors to the real console (so local DX, Vercel log streams, and existing
// `vi.spyOn(console, ...)` test assertions keep working) and, when PostHog is configured,
// also emits an OTel log record through the global LoggerProvider registered by
// `src/instrumentation.ts` (see src/lib/logging/otel.ts). Console functions are looked up
// at CALL time, not import time, so the mirror always hits whatever a test (or any other
// instrumentation) has patched onto `console` by the time the log fires.
//
// Serverless contract, bounded: server actions / route handlers can freeze right after
// responding, so EVERY level awaits a forceFlush of the provider — but the wait is
// capped at FLUSH_WAIT_MS (and the exporter itself at 2s, see otel.ts) so a PostHog
// outage can never add multi-second latency to a request. info used to fire-and-forget
// its flush, which silently lost the record whenever the runtime froze before the
// export finished — on low-traffic routes (the 15-minute billing sweeps) nearly every
// info log vanished, since no follow-up request thawed the instance to flush the queue.
// Same rationale as the awaited `flush()` in src/lib/analytics/server.ts.
//
// Attribute flattening lives in worker/src/log-attributes.ts — the cross-service contract
// shared with the worker logger (worker/src/log.ts). Fix flattening there, never here.
//
// Request correlation: every PostHog record is auto-stamped with the per-request
// `request_id` (the `x-request-id` header the proxy mints in src/proxy.ts), so all logs
// emitted while handling one request share a queryable id without any call site passing
// it. The id is read from `next/headers` defensively — outside a request scope (background
// jobs, instrumentation) or during static prerender the read fails and the record simply
// ships without a request_id. The console mirror is left untouched so existing console-spy
// assertions across the app keep matching byte-for-byte; correlation lives on the OTel
// record where it's queryable. An explicit `request_id` in the call's attributes wins.
//
// Tenant correlation: records are likewise auto-stamped with the active `org_id` once the
// auth seam (getAuthContext) has resolved it into the per-request log context
// (./request-context.ts), mirroring the worker logger's `org_id`. The signed-in `user_id`
// is stamped the same way, so app logs can also be filtered per identity. Same rules:
// best-effort, no-op outside a request scope, an explicit attribute wins.
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
import { currentLogContext } from "./request-context";

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

// The current request's `x-request-id`, or undefined when there is no request scope.
// `next/headers` `headers()` throws outside a request (background work, instrumentation)
// and signals a dynamic bail during static prerender — both are caught here, so the log
// degrades to no request_id rather than throwing or forcing a route dynamic.
async function currentRequestId(): Promise<string | undefined> {
  try {
    const { headers } = await import("next/headers");
    return (await headers()).get("x-request-id") ?? undefined;
  } catch {
    return undefined;
  }
}

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
    const flat = attributes ? flattenAttributes(attributes) : {};
    const requestId = await currentRequestId();
    // Stamp the request id unless the caller passed one explicitly (caller wins).
    if (requestId !== undefined && flat.request_id === undefined) {
      flat.request_id = requestId;
    }
    // Stamp the active tenant and signed-in user the same way (caller-supplied wins).
    const { org_id, user_id } = currentLogContext();
    if (org_id !== undefined && flat.org_id === undefined) {
      flat.org_id = org_id;
    }
    if (user_id !== undefined && flat.user_id === undefined) {
      flat.user_id = user_id;
    }
    logs.getLogger("baseline-app").emit({
      severityNumber: SEVERITY_NUMBER[level],
      severityText: level.toUpperCase(),
      body: message,
      attributes: Object.keys(flat).length > 0 ? flat : undefined,
    });

    // Flush so records ship before a serverless runtime can freeze. The global provider
    // is the SDK LoggerProvider registered in instrumentation; duck-type forceFlush
    // because the api-logs interface (and the unregistered proxy/noop fallbacks) don't
    // carry it. Awaited at every level, capped at FLUSH_WAIT_MS.
    const provider = logs.getLoggerProvider() as { forceFlush?: () => Promise<void> };
    if (typeof provider.forceFlush === "function") {
      const flushed = provider.forceFlush().catch(() => {});
      await Promise.race([flushed, flushWaitCap()]);
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
