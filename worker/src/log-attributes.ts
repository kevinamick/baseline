// Attribute flattening for PostHog Logs (issue #38) — the cross-service contract.
//
// This file is THE single flattening implementation: the worker's logger
// (worker/src/log.ts) and the Next.js app's logger (src/lib/logging/server.ts) both
// call it, so the `event` / `error_message` / `error_detail` attribute shapes stay
// queryable uniformly across services in PostHog and can never drift apart.
//
// It lives in worker/src — not src/lib — because the worker's Docker build copies only
// the worker/ directory (see worker/Dockerfile and worker/src/prompt-refs.ts for the
// same pattern), while the Next.js app can reach across the repo.
//
// INVARIANT: this file must stay import-free (no imports, not even worker-local ones).
// The Next.js app bundles it directly, so any worker-side dependency added here would
// leak into the app bundle — or break the Next build outright (NodeNext ".js"
// specifiers, worker-only deps like @temporalio/*). src/lib/logging/__tests__/
// server.test.ts has a guard test that fails if an import sneaks in.

export const LOG_LEVELS = ["info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogAttributes = Record<string, unknown> & { error?: unknown };

// PII: for plain (Supabase/Postgres-style) error objects, only these diagnostic fields
// are forwarded into `error_detail`. Never serialize the whole error — Postgres embeds
// row values in `detail` (e.g. `Key (org_id, email)=(…, person@example.com) already
// exists`), which would ship personal data to a third party (GDPR).
const ERROR_DETAIL_FIELDS = ["code", "hint", "name"] as const;

// Flatten arbitrary attributes into OTel-friendly scalars. The `error` key gets special
// treatment: Error instances become error_message + error_stack; plain objects with a
// `message` ({ message, code, ... }) keep their message plus the whitelisted diagnostic
// fields above. Must never throw — a log call failing would be worse than the condition
// being logged.
export function flattenAttributes(
  attributes: LogAttributes
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (key === "error") {
      if (value instanceof Error) {
        out.error_message = value.message;
        if (value.stack) out.error_stack = value.stack;
      } else if (typeof value === "object" && "message" in value) {
        out.error_message = safeStringify((value as { message: unknown }).message);
        const detail: Record<string, string> = {};
        for (const field of ERROR_DETAIL_FIELDS) {
          const v = (value as Record<string, unknown>)[field];
          if (v !== undefined && v !== null) detail[field] = safeStringify(v);
        }
        if (Object.keys(detail).length > 0) out.error_detail = safeStringify(detail);
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

export function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    // String() itself can throw on exotic values (null-prototype objects, throwing
    // Symbol.toPrimitive) — exactly the kind that already made JSON.stringify throw.
    // Degrade to a placeholder so one bad attribute never drops the whole record.
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}
