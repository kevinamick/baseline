// Extracts the PostHog distinct_id from a request's Cookie header.
//
// posthog-js persists its state in a cookie named `ph_<project key>_posthog` whose
// value is URL-encoded JSON carrying `distinct_id`. Server-side error capture
// (onRequestError in src/instrumentation.ts) uses this to attribute exceptions to the
// same person the client SDK tracks. Pure and best-effort: any malformed input
// (missing cookie, bad JSON, array headers) yields null, never a throw.

export function distinctIdFromCookieHeader(
  cookieHeader: string | string[] | undefined
): string | null {
  if (!cookieHeader) return null;
  const cookie = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;

  const match = cookie.match(/ph_phc_.*?_posthog=([^;]+)/);
  if (!match) return null;

  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(match[1]));
    const distinctId = (parsed as { distinct_id?: unknown })?.distinct_id;
    return typeof distinctId === "string" && distinctId ? distinctId : null;
  } catch {
    return null;
  }
}
