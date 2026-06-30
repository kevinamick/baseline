// The user-facing message for a failed Zod parse: every server action that
// returns `{ error }` to a form surfaces the first issue's message, falling
// back to an action-specific default when the schema produced no message.
// Extracted from ~12 identical `parsed.error.issues[0]?.message ?? fallback`
// sites across the action layer so the "first issue wins" convention lives in
// one place. Typed structurally (not against `ZodError`) so it stays free of
// Zod generic-variance friction and works for any safeParse error shape.
export function firstIssueMessage(
  error: { issues: ReadonlyArray<{ message: string }> },
  fallback: string,
): string {
  return error.issues[0]?.message ?? fallback;
}
