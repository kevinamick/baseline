import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { BrandMark } from "./brand-mark";

/**
 * The shared top bar for the marketing surfaces outside the landing page —
 * docs, blog (index + post), the category guides, and the comparison pages.
 * One definition so the auth-aware CTA can't drift between them (it used to be
 * five hand-copied headers, each hardcoding "Get started free" → /sign-up).
 *
 * Auth-aware, mirroring `LandingNav`: a signed-in visitor gets "Open Baseline"
 * → the app, everyone else gets "Get started free" → sign-up. Every page that
 * renders this is already `force-dynamic` (the root layout reads `headers()`
 * for the CSP nonce), so reading the session cookie here adds no static-render
 * cost. The Nav copy (`pricing`, `openBaseline`, `getStartedFree`) is shared
 * with `LandingNav` under the `Nav` catalog scope.
 */
export async function MarketingHeader() {
  const t = await getTranslations("Nav");
  const { userId } = await getAuthContext();
  const signedIn = Boolean(userId);

  return (
    <header className="flex items-center gap-3 px-6 py-4">
      <Link
        href="/"
        className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-card px-[18px] py-[9px] text-sm font-semibold tracking-[-0.01em] text-ink"
      >
        <BrandMark size={20} />
        Baseline
      </Link>
      <div className="flex-1" />
      <Link
        href="/pricing"
        className="rounded-full px-3.5 py-2 text-sm font-medium text-fg-2 transition-colors hover:text-ink"
      >
        {t("pricing")}
      </Link>
      <Link
        href={signedIn ? "/dashboard" : "/sign-up"}
        className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
      >
        {signedIn ? t("openBaseline") : t("getStartedFree")}
      </Link>
    </header>
  );
}
