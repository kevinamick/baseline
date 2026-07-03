import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { BrandMark } from "@/app/_components/brand-mark";
import { SiteFooter } from "@/app/_components/site-footer";
import { ThemeStamp } from "@/app/_components/theme-stamp";

// Static (no params, no async work — not-found.js components accept no props):
// this metadata is what Next attaches to every 404 response rendered under the
// `[locale]` tree, alongside the `noindex` robots tag Next injects automatically
// for any 404 response.
export const metadata: Metadata = {
  title: "Page not found · Baseline",
  description:
    "This page doesn't exist. Head back to the Baseline home page or your dashboard.",
};

/**
 * Renders for any request under the `[locale]` segment that doesn't match a
 * route (#387's "shared 404"). It sits inside the locale layout, so it gets
 * the same `<html>`/`<body>` shell, fonts, and providers as every other page —
 * unlike Next's built-in fallback, which renders completely unstyled. Kept a
 * synchronous Server Component (no `async`/`await`): `useTranslations` from
 * `next-intl` (not `next-intl/server`) reads the locale already resolved by
 * the parent layout's `setRequestLocale` without an await.
 */
export default function NotFound() {
  const t = useTranslations("NotFound");

  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      {/* The not-found shell never runs the layout's pre-paint theme script —
          re-stamp [data-theme] from the client bundle (see theme-stamp.tsx). */}
      <ThemeStamp />
      <header className="flex px-6 py-4">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-card px-[18px] py-[9px] text-sm font-semibold tracking-[-0.01em] text-ink transition-colors hover:bg-card-warm"
        >
          <BrandMark size={20} />
          Baseline
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center px-6 py-10 text-center">
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">
          {t("heading")}
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-fg-2">
          {t("body")}
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
          >
            {t("homeCta")}
          </Link>
          <Link
            href="/dashboard"
            className="rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-card-warm"
          >
            {t("dashboardCta")}
          </Link>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
