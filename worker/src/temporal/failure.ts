// Shared workflow-side error helper. Pure (no Node imports, no side effects), so it is
// safe to import from inside Temporal's deterministic sandbox.

// Unwrap an error to its deepest `cause` message. Temporal wraps an Activity's
// ApplicationFailure in an ActivityFailure whose own message is generic; the actionable
// text is on the cause chain.
export function rootCauseMessage(err: unknown): string {
  let cur: unknown = err;
  let message = err instanceof Error ? err.message : String(err);
  const seen = new Set<unknown>();
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const { message: m, cause } = cur as { message?: unknown; cause?: unknown };
    if (typeof m === "string" && m.length > 0) message = m;
    cur = cause;
  }
  return message;
}
