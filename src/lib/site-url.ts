/**
 * The site's canonical public origin — the single source of truth for
 * `metadataBase`, canonical URLs, `hreflang` alternates, sitemap entries, and
 * robots. It reuses `NEXT_PUBLIC_APP_URL` (the same origin already used for email
 * links, checkout redirects, and auth callbacks) rather than introducing a second
 * base-URL variable. Falls back to localhost for local dev, where the var may be
 * unset; staging/prod set it to the real origin.
 *
 * Read at call time (not a module constant) so tests and request-time code see
 * the current env value.
 */
export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    ""
  );
}

/** Absolute URL for an app-relative `path` (which must start with "/"). */
export function absoluteUrl(path: string): string {
  return path === "/" ? siteUrl() : `${siteUrl()}${path}`;
}
