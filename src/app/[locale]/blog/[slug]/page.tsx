import type { Metadata } from "next";
import { MarketingHeader } from "@/app/_components/marketing-header";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import type { AppLocale } from "@/i18n/routing";
import { buildMarketingAlternates } from "@/i18n/metadata";
import {
  breadcrumbListSchema,
  defaultOpenGraph,
  defaultTwitter,
  blogPostingSchema,
} from "@/lib/seo";
import { getPost } from "@/lib/marketing/posts";
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

  const tBlog = await getTranslations("Marketing.blog");
  const labels = { publishedLabel: tBlog("publishedLabel") };
  // Site-hierarchy trail: Home → Blog → this post. The "Blog" crumb reuses the
  // blog hub's own visible heading, so the label stays single-sourced per locale.
  const homeLabel = (await getTranslations("Marketing.breadcrumb"))("home");
  const breadcrumbs = [
    { name: homeLabel, path: "/" },
    { name: tBlog("heading"), path: "/blog" },
    { name: post.heading, path: `/blog/${post.slug}` },
  ];
  // Per-request CSP nonce (minted in proxy.ts) so the JSON-LD block is trusted
  // under the strict nonce policy — same source category-route.tsx reads.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      <JsonLd schema={blogPostingSchema(post)} nonce={nonce} />
      <JsonLd schema={breadcrumbListSchema(locale, breadcrumbs)} nonce={nonce} />

      <MarketingHeader />

      <main className="flex flex-1 flex-col">
        <PostContent post={post} labels={labels} locale={locale as AppLocale} />
      </main>

      <SiteFooter />
    </div>
  );
}
