// Shared server-side PostHog client (posthog-node singleton).
//
// Lives outside `server.ts` because that module is `server-only`, which would block
// `src/instrumentation.ts` (the onRequestError hook) from importing it — the
// instrumentation bundle is compiled without the react-server condition. Keep this
// file free of `server-only`; it must never be imported from client components.

import { PostHog } from "posthog-node";

let cached: PostHog | null = null;

// Returns the shared client, or null without the key (graceful degradation).
export function getPostHogServer(): PostHog | null {
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
