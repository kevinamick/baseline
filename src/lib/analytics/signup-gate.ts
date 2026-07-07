import "server-only";
import { PostHog } from "posthog-node";

/**
 * The launch-phase sign-up gate (ADR-0017, #425). While `signup-access-code-gate`
 * is on, creating an account requires a pending Invitation matching the sign-up
 * email — this slice enforces the gate only; Access Codes themselves (the other
 * bypass) ship in a later slice. Both `signUp` (src/app/actions/auth.ts) and the
 * `/sign-up` page call `isSignupGated()` below, so they can never disagree about
 * the current gate state (no split-brain between the page's copy and the
 * action's enforcement).
 *
 * This mirrors the worker's operational kill-switch helper
 * (`isKillSwitchFlagEnabled`, worker/src/telemetry.ts) — server-side evaluation,
 * anonymous distinctId, never throws — but fails in the OPPOSITE direction,
 * deliberately (ADR-0017): a kill switch defaults to the shipped behavior when
 * PostHog can't be read; a sign-up gate must default to the SAFE behavior, and
 * here "safe" means gated, not open. Matrix:
 *
 *   - PostHog unconfigured (no POSTHOG_KEY — dev/CI/e2e default): ungated. There's
 *     no control plane to read, so the pre-launch-gate (shipped) behavior stands.
 *   - PostHog configured: the flag decides.
 *   - Evaluation error, undefined result, or a response slower than
 *     FLAG_EVAL_TIMEOUT_MS: GATED. An outage must never silently open
 *     registration — coded/invited sign-ups don't depend on this flag, so they
 *     still get through while PostHog is down.
 *
 * Uses its OWN `POSTHOG_KEY`/`POSTHOG_HOST` — not the client bundle's
 * `NEXT_PUBLIC_POSTHOG_KEY`/`NEXT_PUBLIC_POSTHOG_HOST` (src/lib/analytics/server.ts)
 * — for two reasons: (1) e2e can then point this ONE evaluation path at a local
 * PostHog mock without touching client-side analytics/consent for the rest of the
 * suite, and (2) a plain (non-`NEXT_PUBLIC_`) var is read from `process.env` at
 * request time, whereas `NEXT_PUBLIC_*` vars are substituted into the bundle by
 * Next at BUILD time — which would freeze the e2e build's PostHog host for the
 * whole run instead of letting a mock decide the flag per test.
 *
 * The flag is a transition lever, not permanent config: when the gate is retired
 * for good, this file and every call site reading it are deleted together (a
 * fail-closed default left in place would re-gate sign-up on any future PostHog
 * outage for no reason).
 */
export const SIGNUP_ACCESS_CODE_GATE_FLAG = "signup-access-code-gate";

// The gate has no signed-in user yet, so there's nothing per-user to key
// evaluation on — a fixed anonymous id keeps the flag's rollout math (if ever
// used for a percentage rollout) stable across sign-up attempts.
const ANONYMOUS_DISTINCT_ID = "signup-gate";

// Both call sites run inline in a user-facing request (a page render, a form
// submit) — evaluation must be bounded so a PostHog outage fails fast into the
// closed state rather than hanging the page/action.
const FLAG_EVAL_TIMEOUT_MS = 3_000;

let cached: PostHog | null = null;

function client(): PostHog | null {
  const key = process.env.POSTHOG_KEY;
  if (!key) return null;
  if (!cached) {
    cached = new PostHog(key, {
      host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return cached;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("PostHog flag evaluation timed out")),
      timeoutMs
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Is the launch-phase sign-up Access Code gate currently up? Never throws. */
export async function isSignupGated(): Promise<boolean> {
  const ph = client();
  if (!ph) return false;
  try {
    const enabled = await withTimeout(
      ph.isFeatureEnabled(SIGNUP_ACCESS_CODE_GATE_FLAG, ANONYMOUS_DISTINCT_ID, {
        // This is an internal gate check, not a user-facing experiment — skip
        // the `$feature_flag_called` analytics capture PostHog would otherwise
        // fire on every single sign-up page view and submission.
        sendFeatureFlagEvents: false,
      }),
      FLAG_EVAL_TIMEOUT_MS
    );
    // Fail-closed polarity: only an EXPLICIT `false` (the flag is readable and
    // off) counts as ungated. `undefined` (posthog-node's "flag not found /
    // unreadable" result) falls through to gated, same as a thrown error below.
    return enabled !== false;
  } catch {
    return true;
  }
}
