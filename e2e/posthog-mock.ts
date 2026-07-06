// Client for the local PostHog mock server (posthog-mock-server.mjs) that backs
// the launch-phase sign-up gate e2e coverage (ADR-0017, #425). Spec-local rather
// than added to constants.ts: it's the one file (e2e/signup-gate.spec.ts) that
// drives this control surface.
export const POSTHOG_MOCK_PORT = Number(process.env.POSTHOG_MOCK_PORT ?? 4310);
export const POSTHOG_MOCK_URL = `http://127.0.0.1:${POSTHOG_MOCK_PORT}`;

export type SignupGateState = "on" | "off" | "error" | "timeout";

/**
 * Set the mock's current `/flags` decision. Every subsequent evaluation of
 * `signup-access-code-gate` by the app under test (any /sign-up render or
 * signUp submission, from any spec) reads this until it's changed again — the
 * mock has no per-request keying, so callers must serialize around it. See
 * signup-gate.spec.ts's own dedicated Playwright project, which runs after
 * every other spec has finished so nothing else races this.
 */
export async function setSignupGateState(state: SignupGateState): Promise<void> {
  const res = await fetch(`${POSTHOG_MOCK_URL}/__mock__/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) {
    throw new Error(`posthog-mock: failed to set state=${state} (${res.status})`);
  }
}
