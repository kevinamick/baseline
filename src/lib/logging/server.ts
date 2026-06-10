// Structured server-side logging → PostHog Logs (issue #38).
//
// Every call mirrors to the real console (so local DX, Vercel log streams, and existing
// `vi.spyOn(console, ...)` test assertions keep working) and, when PostHog is configured,
// also emits an OTel log record through the global LoggerProvider registered by
// `src/instrumentation.ts` (see src/lib/logging/otel.ts).
//
// Serverless contract: server actions / route handlers can freeze right after responding,
// so each call force-flushes the provider before resolving — same rationale as the awaited
// `flush()` in src/lib/analytics/server.ts. Logging is strictly best-effort: it never
// throws and never rejects, no matter what PostHog is doing.

import "server-only";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

export const LOG_LEVELS = ["info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogAttributes = Record<string, unknown> & { error?: unknown };

const SEVERITY_NUMBER: Record<LogLevel, SeverityNumber> = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

const CONSOLE_FN: Record<LogLevel, (...args: unknown[]) => void> = {
  info: console.log,
  warn: console.warn,
  error: console.error,
};

// Flatten arbitrary attributes into OTel-friendly scalars. The `error` key gets special
// treatment: Error instances become error_message + error_stack; Supabase-style plain
// objects ({ message, code, ... }) keep their message and serialize the rest. Must never
// throw — a log call failing would be worse than the condition being logged.
function flattenAttributes(attributes: LogAttributes): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (key === "error") {
      if (value instanceof Error) {
        out.error_message = value.message;
        if (value.stack) out.error_stack = value.stack;
      } else if (typeof value === "object" && "message" in value) {
        out.error_message = String((value as { message: unknown }).message);
        out.error_detail = safeStringify(value);
      } else {
        out.error_message = safeStringify(value);
      }
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else {
      out[key] = safeStringify(value);
    }
  }
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
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

    // Required on serverless: flush before the runtime can freeze. The global provider is
    // the SDK LoggerProvider registered in instrumentation; duck-type forceFlush because
    // the api-logs interface (and the unregistered proxy/noop fallbacks) don't carry it.
    const provider = logs.getLoggerProvider() as { forceFlush?: () => Promise<void> };
    if (typeof provider.forceFlush === "function") await provider.forceFlush();
  } catch {
    // best-effort: never reject or block a request on PostHog being down
  }
}

export const log = {
  info: (message: string, attributes?: LogAttributes) => emit("info", message, attributes),
  warn: (message: string, attributes?: LogAttributes) => emit("warn", message, attributes),
  error: (message: string, attributes?: LogAttributes) => emit("error", message, attributes),
};
