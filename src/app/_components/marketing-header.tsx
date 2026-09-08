import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { BrandMark } from "./brand-mark";

/**
 * The shared top bar for the marketing surfaces outside the landing page —
 * docs, blog (index + post), the category guides, and the comparison pages.
 * One definition so the CTA can't drift between them. With no sign-in
 * (ADR-0020) the CTA always opens the Local Workspace.
 */
export async function MarketingHeader() {
  const t = await getTranslations("Nav");

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
        href="/dashboard"
        className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
      >
        {t("openBaseline")}
      </Link>
    </header>
  );
}
