import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { CookiePreferencesButton } from "@/app/_components/cookie-preferences-button";

/**
 * Shared marketing/auth footer. Carries the persistent links to the privacy
 * notice and the (revisitable) cookie preferences. Kept deliberately minimal so
 * it sits quietly under the landing, pricing, and auth surfaces.
 */
export function SiteFooter() {
  const t = useTranslations("Footer");
  const year = new Date().getFullYear();
  return (
    <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-6 py-6 text-xs text-fg-3">
      <span>{t("copyright", { year })}</span>
      <span aria-hidden="true">·</span>
      <Link href="/privacy" className="transition-colors hover:text-ink">
        {t("privacy")}
      </Link>
      <span aria-hidden="true">·</span>
      <CookiePreferencesButton className="transition-colors hover:text-ink">
        {t("cookiePreferences")}
      </CookiePreferencesButton>
    </footer>
  );
}
