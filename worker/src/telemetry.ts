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

// Report a worker exception to PostHog error tracking. Signature kept stable for
// the existing call sites (worker.ts) and unmerged PRs #161/#162. Best-effort:
// no-op without a PostHog key, and the flush never rejects the caller.
export function captureException(err: unknown, context?: Record<string, unknown>) {
  const ph = posthog();
  if (!ph) return;
  ph.captureException(err, "worker", context);
  void ph.flush().catch(() => {});
}
