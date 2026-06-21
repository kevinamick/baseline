"use client";

import { BrandMark } from "@/app/_components/brand-mark";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { CookiePreferencesButton } from "@/app/_components/cookie-preferences-button";

/**
 * Shared chrome for the standalone auth pages (sign-in, sign-up,
 * forgot-password, reset-password): the paper background, a logo header linking
 * home, and a centered slot for the form card.
 *
 * A client component (like SiteFooter) so its one translated string resolves
 * from the NextIntlClientProvider — correct on /es even when the wrapping auth
 * page renders statically and doesn't call setRequestLocale.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Auth");
  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      <header className="flex px-6 py-4">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-card px-[18px] py-[9px] text-sm font-semibold tracking-[-0.01em] text-ink transition-colors hover:bg-card-warm"
        >
          <BrandMark size={20} />
          Baseline
        </Link>
      </header>
      <div className="flex flex-1 items-center justify-center p-6">
        {children}
      </div>
      <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-6 py-6 text-xs text-fg-3">
        <Link href="/privacy" className="transition-colors hover:text-ink">
          {t("privacyNotice")}
        </Link>
        <span aria-hidden="true">·</span>
        <CookiePreferencesButton className="transition-colors hover:text-ink" />
      </footer>
    </div>
  );
}
