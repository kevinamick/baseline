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
