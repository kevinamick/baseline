import { isClerkAPIResponseError } from "@clerk/nextjs/errors";

const FALLBACK = "Something went wrong creating your team. Please try again.";

/**
 * Maps an error thrown by Clerk's `createOrganization` / `setActive` calls to a
 * user-facing message. Clerk API errors carry a structured `errors` array; we
 * surface the most descriptive message available and fall back to a generic one
 * for network or unexpected failures.
 */
export function createTeamErrorMessage(err: unknown): string {
  if (isClerkAPIResponseError(err)) {
    const first = err.errors[0];
    return first?.longMessage ?? first?.message ?? FALLBACK;
  }
  return FALLBACK;
}
