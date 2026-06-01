import * as Sentry from "@sentry/node";
import { PostHog } from "posthog-node";

type LogLevel = "debug" | "info" | "warning" | "error" | "critical";

export function initTelemetry() {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 1,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.VERCEL_GIT_COMMIT_SHA ?? undefined,
  });
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

export async function log(
  level: LogLevel,
  message: string,
  properties?: Record<string, unknown>
) {
  const ph = posthog();
  if (!ph) return;
  ph.captureLog({
    distinctId: "worker",
    level,
    message,
    properties: {
      ...(properties ?? {}),
      env: process.env.NODE_ENV ?? "development",
      release: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    },
  });
  await ph.flush().catch(() => {});
}

export function captureException(err: unknown, context?: Record<string, unknown>) {
  Sentry.withScope((scope) => {
    if (context) scope.setExtras(context);
    Sentry.captureException(err);
  });
}
