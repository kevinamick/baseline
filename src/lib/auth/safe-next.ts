/**
 * Only permit redirects to a path on the same origin as `base`. Resolving `next`
 * against the base origin and comparing origins defeats absolute URLs, protocol-
 * relative values, and control-character tricks (e.g. "/\t/evil.com", which the
 * URL parser strips to "//evil.com") — i.e. closes the open-redirect hole.
 * Anything that doesn't resolve to a same-origin path returns `fallback`.
 */
export function safeNext(
  raw: string | null | undefined,
  base: string,
  fallback = "/dashboard"
): string {
  if (!raw) return fallback;
  try {
    const origin = new URL(base).origin;
    const url = new URL(raw, origin);
    return url.origin === origin ? url.pathname + url.search : fallback;
  } catch {
    return fallback;
  }
}
