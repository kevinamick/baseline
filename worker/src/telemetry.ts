import { PostHog } from "posthog-node";
import { initLogging } from "./log.js";

export function initTelemetry() {
  // PostHog Logs: wire the OTel LoggerProvider (no-op without POSTHOG_KEY).
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

// Exception capture → PostHog error tracking (issue #166). Keeps the signature the
// call sites (worker.ts, and unmerged PRs #161/#162) rely on: synchronous, never
// throws. The worker is long-running, so the flush is fire-and-forget — the queue
// drains on the next tick (flushAt: 1) and shutdown paths flush via posthog-node.
export function captureException(err: unknown, context?: Record<string, unknown>) {
  const ph = posthog();
  if (!ph) return;
  try {
    ph.captureException(err, "worker", context);
    void ph.flush().catch(() => {});
  } catch {
    // best-effort: telemetry must never take the worker down
  }
}
