import "server-only";
import { PostHog } from "posthog-node";
import type { AnalyticsEvent } from "./events";

let cached: PostHog | null = null;

function client(): PostHog | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  if (!cached) {
    cached = new PostHog(key, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return cached;
}

type Identity = {
  userId?: string | null;
  anonymousId?: string | null;
  requestId?: string | null;
};

export async function track(event: AnalyticsEvent, identity: Identity = {}) {
  const c = client();
  if (!c) return;

  const distinctId = identity.userId ?? identity.anonymousId ?? "anonymous";

  c.capture({
    distinctId,
    event: event.name,
    properties: {
      ...(event.props ?? {}),
      env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
      release: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      request_id: identity.requestId ?? null,
    },
  });

  // Required on serverless: the process can freeze after the response and
  // drop in-memory events. Block until the network call resolves.
  await c.flush().catch(() => {});
}

/**
 * Report an exception to PostHog error tracking from server code (the
 * instrumentation `onRequestError` hook, the rate-limiter fail-open path). Same
 * fire-and-flush shape as `track()` — block on the flush so a serverless freeze
 * after the response can't drop it. No-op without a PostHog key.
 */
export async function captureException(
  error: unknown,
  distinctId = "anonymous",
  properties?: Record<string, unknown>
) {
  const c = client();
  if (!c) return;

  c.captureException(error, distinctId, properties);
  await c.flush().catch(() => {});
}

/**
 * Pull the PostHog distinct_id out of a request's `Cookie` header. posthog-js
 * persists its state in a `ph_<project-key>_posthog` cookie whose URL-encoded
 * JSON value carries `distinct_id`. Returns null when the cookie is absent or
 * unparseable — e.g. a visitor who hasn't accepted analytics never gets one, so
 * their server errors are reported anonymously.
 */
export function distinctIdFromCookie(
  cookieHeader: string | string[] | undefined
): string | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key || !cookieHeader) return null;

  const header = Array.isArray(cookieHeader)
    ? cookieHeader.join("; ")
    : cookieHeader;
  const name = `ph_${key}_posthog`;
  const match = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!match) return null;

  try {
    const value = decodeURIComponent(match.slice(name.length + 1));
    const parsed = JSON.parse(value) as { distinct_id?: unknown };
    return typeof parsed.distinct_id === "string" ? parsed.distinct_id : null;
  } catch {
    return null;
  }
}
