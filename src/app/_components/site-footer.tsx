import Link from "next/link";

/**
 * Shared marketing/auth footer. Carries the persistent link to the privacy
 * notice (the consent banner links there too, but it's dismissible). Kept
 * deliberately minimal so it sits quietly under the landing, pricing, and auth
 * surfaces.
 */
export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-6 py-6 text-xs text-fg-3">
      <span>© {year} Baseline</span>
      <span aria-hidden="true">·</span>
      <Link
        href="/privacy"
        className="transition-colors hover:text-ink"
      >
        Privacy &amp; Cookie Notice
      </Link>
    </footer>
  );
}
