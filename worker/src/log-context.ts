// Ambient run correlation for worker logs (issue #38 follow-up).
//
// The worker is one long-running process that interleaves many runs, and a single run's
// work fans out across deep call sites (provider clients, the evaluator, GEPA activities)
// that have no run handle to pass. Threading `run_id`/`org_id` through every signature just
// to log them is noise, and call sites that forget leave orphan logs you can't correlate.
//
// So a run's identity rides an AsyncLocalStorage scope instead: `runWithLogContext` opens
// the scope around processing one run, and the logger (./log.ts) reads `currentLogContext()`
// and auto-stamps `run_id`/`org_id` onto every OTel record emitted inside it. This mirrors
// the app logger's per-request `request_id` stamping (src/lib/logging/server.ts), which
// reads the request scope from `next/headers`.
//
// The store is intentionally mutable: a run's `org_id` isn't known until the rubric loads,
// after the scope is already open, so `setLogContext` patches it in. An explicit attribute
// on the log call always wins over the ambient value (see ./log.ts).

import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
  run_id?: string;
  org_id?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

// Run `fn` with `ctx` as the ambient log context. The store is the same object reference
// throughout the scope, so later `setLogContext` patches are visible to logs already inside.
export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run({ ...ctx }, fn);
}

// The ambient context, or undefined outside any `runWithLogContext` scope.
export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}

// Patch fields onto the current scope's context (e.g. fill `org_id` once the rubric loads).
// No-op outside a scope, so callers never need to guard.
export function setLogContext(patch: Partial<LogContext>): void {
  const ctx = storage.getStore();
  if (ctx) Object.assign(ctx, patch);
}
