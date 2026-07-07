import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { AppLocale } from "@/i18n/routing";
import { buildMarketingAlternates } from "@/i18n/metadata";
import { defaultOpenGraph, defaultTwitter, blogPostingSchema } from "@/lib/seo";
import { getPost } from "@/lib/marketing/posts";
import { BrandMark } from "@/app/_components/brand-mark";
import { PostContent } from "@/app/_components/post-content";
import { JsonLd } from "@/app/_components/json-ld";
import { SiteFooter } from "@/app/_components/site-footer";

// Render on demand (SSR), like every other marketing route — the root layout
// reads headers() for the per-request CSP nonce (forcing dynamic rendering),
// and this route reads the nonce itself for the JSON-LD block below. Mirrors
// compare/[competitor]/page.tsx: no generateStaticParams/dynamicParams, ADR-0013's
// "the post exists only in its declared locale set" guarantee lives entirely in
// the notFound() guard.
export const dynamic = "force-dynamic";

type PostParams = { locale: string; slug: string };

/** Resolve the post for this request, or 404 outside its declared locale set. */
function resolveOrNotFound(slug: string, locale: string) {
  const post = getPost(slug);
  if (!post || !post.locales.includes(locale as AppLocale)) {
    notFound();
  }
  return post;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<PostParams>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const post = resolveOrNotFound(slug, locale);

  const path = `/blog/${post.slug}`;
  return {
    title: post.metaTitle,
    description: post.metaDescription,
    alternates: buildMarketingAlternates(locale, path, post.locales),
    // No og:image here — the colocated opengraph-image route supplies it.
    openGraph: {
      ...defaultOpenGraph(locale, path, post.metaTitle, post.metaDescription),
      type: "article",
      publishedTime: post.publishedAt,
    },
    twitter: defaultTwitter(post.metaTitle, post.metaDescription),
  };
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<PostParams>;
}) {
  const { locale, slug } = await params;
  const post = resolveOrNotFound(slug, locale);

  const t = await getTranslations("Nav");
  const tBlog = await getTranslations("Marketing.blog");
  const labels = { publishedLabel: tBlog("publishedLabel") };
  // Per-request CSP nonce (minted in proxy.ts) so the JSON-LD block is trusted
  // under the strict nonce policy — same source category-route.tsx reads.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      <JsonLd schema={blogPostingSchema(post)} nonce={nonce} />

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
          href="/sign-up"
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
        >
          {t("getStartedFree")}
        </Link>
      </header>

      <main className="flex flex-1 flex-col">
        <PostContent post={post} labels={labels} locale={locale as AppLocale} />
      </main>

      <SiteFooter />
    </div>
  );
}
