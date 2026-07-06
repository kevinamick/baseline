import { PostHog } from "posthog-node";
import { initLogging } from "./log.js";

export function initTelemetry() {
  // PostHog Logs: wire the OTel LoggerProvider (no-op without POSTHOG_KEY).
  // Events + error tracking use the lazily-created client below.
  initLogging();
}

let _posthog: PostHog | null = null;

function posthog(): PostHog | null {
  const key = process.env.POSTHOG_KEY;
  if (!key) return null;
  if (!_posthog) {
    _posthog = new PostHog(key, {
      host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return _posthog;
}

export async function trackRunCompleted(runId: string, overallScore: number, rowCount: number) {
  const ph = posthog();
  if (!ph) return;
  ph.capture({
    distinctId: "worker",
    event: "eval_run.completed",
    properties: { run_id: runId, overall_score: overallScore, row_count: rowCount },
  });
  await ph.flush().catch(() => {});
}

// Evaluate a PostHog feature flag used as an operational kill switch (#84). The default
// matrix is deliberately asymmetric:
//   - PostHog NOT configured (no POSTHOG_KEY — dev/test): ENABLED. The flag exists to turn a
//     shipped behavior off without a deploy; an environment with no control plane keeps the
//     shipped behavior.
//   - PostHog configured: the flag decides. An evaluation error or an undefined result
//     (posthog-node returns undefined when the flag can't be read) fails to DISABLED — don't
//     run the gated path when the control plane can't actually be read.
// Never throws (matches the best-effort style of the rest of this file): a telemetry failure
// must not fail the Activity that asked.
export async function isKillSwitchFlagEnabled(flag: string, distinctId: string): Promise<boolean> {
  const ph = posthog();
  if (!ph) return true;
  try {
    const enabled = await ph.isFeatureEnabled(flag, distinctId);
    return enabled === true;
  } catch {
    return false;
  }
}

// Report a worker exception to PostHog error tracking. Signature kept stable for
// the existing call sites (worker.ts) and unmerged PRs #161/#162. Best-effort:
// no-op without a PostHog key, and the flush never rejects the caller.
export function captureException(err: unknown, context?: Record<string, unknown>) {
  const ph = posthog();
  if (!ph) return;
  ph.captureException(err, "worker", context);
  void ph.flush().catch(() => {});
}
