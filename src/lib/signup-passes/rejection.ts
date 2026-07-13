/**
 * The signup-pass hook's rejection contract (#487, ADR-0017), in a module with
 * NO `server-only` guard so it can be imported from anywhere — the server
 * action, node/DOM tests, AND the e2e Playwright spec — keeping a single
 * source for the literal instead of hand-copying it into each. A parity test
 * (`src/lib/signup-passes/__tests__/rejection-parity.test.ts`) greps the
 * migration SQL for this exact string so the two sides can never drift.
 */

/**
 * The exact message the hook's 403 rejection carries — must stay
 * byte-identical to `v_reject` in
 * `supabase/migrations/20260712000000_signup_passes.sql`. The signUp action
 * matches on it to map a hook rejection (which should be unreachable for
 * app-originated sign-ups, since the app just minted a pass) to the same
 * generic refusal an uninvited visitor gets, rather than echoing a raw
 * provider error that would out the pass mechanism.
 */
export const SIGNUP_PASS_REJECTION_MESSAGE = "Sign-up is not available.";

/**
 * True when a `supabase.auth.signUp()` error is the signup-pass hook's
 * rejection rather than an ordinary provider error.
 */
export function isSignupPassRejection(error: {
  message: string;
  status?: number;
}): boolean {
  return error.status === 403 && error.message === SIGNUP_PASS_REJECTION_MESSAGE;
}
