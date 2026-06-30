// Ambient tenant correlation for app logs (issue #38 follow-up).
//
// The app logger (./server.ts) already stamps every PostHog record with the per-request
// `request_id` it reads from `next/headers`. That answers "what happened in request Y" but
// not "what happened for tenant X" — and the worker logger already carries `org_id` on
// every record (worker/src/log-context.ts), so app↔worker logs couldn't be filtered to the
// same tenant uniformly. This closes that gap on the app side. The same store also carries
// the signed-in `user_id`, so app logs can additionally be filtered per identity ("what
// happened for this user"), which the worker has no concept of (its runs are org-scoped).
//
// There is no single request-entry seam in the App Router to open an AsyncLocalStorage scope
// the way the worker wraps `processMessage` — the proxy runs in a separate edge bundle and
// doesn't share an async context with the node request handlers. React's `cache()` IS the
// App Router's per-request store, though: the factory runs at most once per server request
// and every caller within that request sees the same object, isolated across requests. So
// the store rides a `cache()`-memoized object, and the single auth seam (`getAuthContext`)
// patches the resolved `org_id` in once it knows it.
//
// Like the worker's scope, the store is mutable (auth resolves after some early-request logs
// may already have fired, which simply ship without an `org_id`) and the reads/writes are
// guarded — outside a request scope `cache()` has nothing to key on, so they degrade to a
// no-op rather than throwing. An explicit `org_id` on the log call always wins (see ./server.ts).

import "server-only";
import { cache } from "react";

export interface RequestLogContext {
  /** The active tenant for this request, mirroring the worker logger's `org_id`. */
  org_id?: string;
  /** The signed-in user for this request, so logs can be filtered per identity. */
  user_id?: string;
}

// Per-request mutable store. `cache(() => ({}))` returns one object per server request,
// shared across every caller within it and isolated between requests.
const requestLogStore = cache((): RequestLogContext => ({}));

// Patch fields onto the current request's log context (e.g. fill `org_id` once auth
// resolves). No-op outside a request scope, so callers never need to guard.
export function setLogContext(patch: RequestLogContext): void {
  try {
    Object.assign(requestLogStore(), patch);
  } catch {
    // Outside a request scope there's nothing to correlate; never throw from logging plumbing.
  }
}

// The current request's log context, or an empty object outside a request scope.
export function currentLogContext(): RequestLogContext {
  try {
    return requestLogStore();
  } catch {
    return {};
  }
}
