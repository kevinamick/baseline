import "server-only";
import { captureException } from "@/lib/analytics/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/logging/server";
import { RATE_LIMITS, type Keytype, type Surface } from "./config";
import { hashKey, normalizeEmail, windowStart } from "./keys";

// The one place every protected surface calls (#209, ADR-0010). Enforcement lives
// inside the action because server actions are opaque same-path POSTs that the
// proxy can't distinguish — so each surface calls checkLimit() explicitly.

/**
 * Whether enforcement is on. Defaults ON; disabled only by an explicit
 * `RATE_LIMIT_ENABLED=false`. NEVER keyed on NODE_ENV — the e2e suite runs the
 * production bundle, so a NODE_ENV check would leave the limiter on in e2e (it's
 * turned off there via this env var) and the suite would flake. Read per-call so
 * tests can flip it.
 */
function rateLimitEnabled(): boolean {
  return process.env.RATE_LIMIT_ENABLED !== "false";
}

// A limiter check that hangs must not hang the request. We race the RPC against a
// short timeout; a timeout counts as a failure and fails open (see below).
const LIMITER_TIMEOUT_MS = 1000;

const GENERIC_LIMIT_MESSAGE = "Too many requests. Please try again later.";

/** Caller-facing message for the visible (per-IP / authenticated) 429 path. */
export function rateLimitMessage(): string {
  return GENERIC_LIMIT_MESSAGE;
}

/**
 * Increment the counter for one (surface, keytype, value) and report whether the
 * request is now over the limit. `true` ⇒ the caller should block (silent-drop or
 * 429, the caller's choice). Always normalizes + hashes the value before it
 * reaches Postgres.
 *
 * Fail-OPEN: if the limiter is disabled, errors, or times out, this returns
 * `false` (allow) and reports to PostHog. The limiter is defense-in-depth, not the
 * primary gate; a limiter that can take down login is worse than a brief gap in a
 * secondary control (ADR-0010).
 *
 * For email-keyed enumeration-sensitive surfaces, call this BEFORE any
 * account-existence branch so a real and a non-existent address are limited
 * identically.
 */
export async function checkLimit(
  surface: Surface,
  keytype: Keytype,
  rawValue: string
): Promise<boolean> {
  if (!rateLimitEnabled()) return false;

  const rule = RATE_LIMITS[surface]?.[keytype];
  if (!rule) {
    // A missing rule is a wiring bug, not a reason to block a user.
    log.warn("rate_limit.no_rule", { surface, keytype });
    return false;
  }

  const normalized = keytype === "email" ? normalizeEmail(rawValue) : rawValue;
  const key = hashKey(surface, keytype, normalized);

  try {
    const count = await withTimeout(
      supabaseAdmin
        .rpc("increment_rate_limit", {
          p_hashed_key: key,
          p_window_start: windowStart(rule.windowMs),
          p_surface: surface,
          p_keytype: keytype,
        })
        .then(({ data, error }) => {
          if (error) throw new Error(error.message);
          return Number(data);
        })
    );

    const limited = count > rule.limit;
    // PII-free decision telemetry: surface/keytype/outcome + the hashed key only.
    log.info("rate_limit.decision", {
      surface,
      keytype,
      outcome: limited ? "limited" : "allowed",
      key,
    });
    return limited;
  } catch (err) {
    // Fail open. Error tracking is reserved for exactly this error path.
    await captureException(err, "rate-limiter", {
      rate_limit_surface: surface,
      rate_limit_keytype: keytype,
    });
    log.error("rate_limit.fail_open", {
      surface,
      keytype,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function withTimeout<T>(promise: PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("rate limiter timed out")),
      LIMITER_TIMEOUT_MS
    );
    (timer as unknown as { unref?: () => void }).unref?.();
    Promise.resolve(promise).then(
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
