/**
 * The site's canonical public origin — the single source of truth for
 * `metadataBase`, canonical URLs, `hreflang` alternates, sitemap entries, and
 * robots. It reuses `NEXT_PUBLIC_APP_URL` (the same origin already used for email
 * links, checkout redirects, and auth callbacks) rather than introducing a second
 * base-URL variable. Falls back to localhost for local dev, where the var may be
 * unset; staging/prod set it to the real origin.
 *
 * `NEXT_PUBLIC_*` vars are inlined at build time, so in the built app the value
 * is frozen regardless. Reading it inside the function (not a module constant)
 * exists so the Vitest tests, which mutate `process.env` per-test, see the
 * current value.
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
