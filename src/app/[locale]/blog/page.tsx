import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import { buildMarketingAlternates } from "@/i18n/metadata";
import { defaultOpenGraph, defaultTwitter } from "@/lib/seo";
import { postsNewestFirst } from "@/lib/marketing/posts";
import { formatVerifiedDate } from "@/lib/marketing/format-date";
import { BrandMark } from "@/app/_components/brand-mark";
import { SiteFooter } from "@/app/_components/site-footer";

// Render on demand — the nonce-CSP root layout forces dynamic rendering, so
// every marketing route in this app sets this explicitly (see docs/page.tsx,
// category-route.tsx).
export const dynamic = "force-dynamic";

type Params = { locale: string };

const PATH = "/blog";

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Marketing.blog" });
  const title = t("metaTitle");
  const description = t("metaDescription");
  return {
    title,
    description,
    // The index is tri-lingual chrome even though the first post is en-only
    // (ADR-0013): it's a stable hub, not a per-post page, so it self-canonicals
    // across the full locale set the same way /docs does.
    alternates: buildMarketingAlternates(locale, PATH, ["en", "es", "fr"]),
    openGraph: defaultOpenGraph(locale, PATH, title, description),
    twitter: defaultTwitter(title, description),
  };
}

export default async function BlogIndexPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { locale } = await params;
  const tNav = await getTranslations({ locale, namespace: "Nav" });
  const t = await getTranslations({ locale, namespace: "Marketing.blog" });

  const posts = postsNewestFirst().filter((post) =>
    post.locales.includes(locale as AppLocale)
  );

  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
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
          {tNav("pricing")}
        </Link>
        <Link
          href="/sign-up"
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
        >
          {tNav("getStartedFree")}
        </Link>
      </header>

      <main className="mx-auto w-full max-w-[880px] flex-1 px-6 py-12">
        <div className="mb-14 flex flex-col gap-3">
          <h1 className="text-[clamp(2rem,4vw,3rem)] font-semibold leading-tight tracking-[-0.025em] text-ink">
            {t("heading")}
          </h1>
          <p className="max-w-[56ch] text-[17px] leading-relaxed text-fg-2">
            {t("subtitle")}
          </p>
        </div>

        <div className="flex flex-col gap-6">
          {posts.map((post) => (
            <Link
              key={post.slug}
              href={`/blog/${post.slug}`}
              className="group flex flex-col gap-2 rounded-2xl border border-hairline-cool bg-card p-6 shadow-card transition-all duration-150 hover:-translate-y-[2px] hover:border-hairline-strong hover:shadow-lg"
            >
              <p className="text-xs text-fg-3">
                <time dateTime={post.publishedAt}>
                  {formatVerifiedDate(post.publishedAt, locale as AppLocale)}
                </time>
              </p>
              <h2 className="text-xl font-semibold leading-snug tracking-[-0.01em] text-ink">
                {post.heading}
              </h2>
              <p className="text-[15px] leading-relaxed text-fg-2">
                {post.description}
              </p>
              <span className="mt-2 text-sm font-medium text-accent-ink transition-colors group-hover:text-ink">
                {t("readCta")} <span aria-hidden="true">→</span>
              </span>
            </Link>
          ))}
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
