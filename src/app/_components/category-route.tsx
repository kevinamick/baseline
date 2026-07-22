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
  faqPageSchema,
  howToSchema,
  softwareApplicationSchema,
} from "@/lib/seo";
import { getCategory } from "@/lib/marketing/categories";
import { CategoryContent } from "@/app/_components/category-content";
import { JsonLd } from "@/app/_components/json-ld";
import { SiteFooter } from "@/app/_components/site-footer";

// Shared wiring for every `/{slug}` category lander (#278). The four routes are
// thin files that defer to these two helpers, so the template, metadata, locale-set
// guard, and SoftwareApplication graph live in exactly one place — adding a category
// is a data change plus a one-line route file.
//
// Like the comparison pages, these render on demand: the root layout reads headers()
// for the per-request CSP nonce (forcing dynamic rendering), so each route sets
// `export const dynamic = "force-dynamic"` and skips generateStaticParams. ADR-0013's
// "en-only; /es|fr/{slug} and unknown slugs are uncrawlable" guarantee lives entirely
// in the notFound() guard below.

type CategoryParams = { locale: string };

/** Resolve the category for this request, or 404 outside its declared locale set. */
function resolveOrNotFound(slug: string, locale: string) {
  // Resolve into the request locale (#280): es/fr overlay their translation, en is
  // canonical. The guard below still gates on the declared locale set.
  const category = getCategory(slug, locale as AppLocale);
  // Guard (mirrored in metadata and the page): a marketing page exists only in its
  // declared locale set, so a request outside it must 404, never serve.
  if (!category || !category.locales.includes(locale as AppLocale)) {
    notFound();
  }
  return category;
}

/** Metadata for a category route — self-canonical, full hreflang cluster (#280). */
export async function categoryMetadata(
  slug: string,
  params: Promise<CategoryParams>
): Promise<Metadata> {
  const { locale } = await params;
  const category = resolveOrNotFound(slug, locale);

  const path = `/${category.slug}`;
  return {
    title: category.metaTitle,
    description: category.metaDescription,
    alternates: buildMarketingAlternates(locale, path, category.locales),
    // No og:image here — the colocated opengraph-image route supplies it.
    openGraph: defaultOpenGraph(
      locale,
      path,
      category.metaTitle,
      category.metaDescription
    ),
    twitter: defaultTwitter(category.metaTitle, category.metaDescription),
  };
}

/** The rendered category lander: brand nav, prose body, SoftwareApplication graph. */
export async function CategoryRoute({
  slug,
  params,
}: {
  slug: string;
  params: Promise<CategoryParams>;
}) {
  const { locale } = await params;
  const category = resolveOrNotFound(slug, locale);

  // Localized section headings (#280); the prose is already in `category`.
  const tCat = await getTranslations("Marketing.category");
  const labels = {
    explainerHeading: tCat("explainerHeading"),
    walkthroughHeading: tCat("walkthroughHeading"),
    howHeading: tCat("howHeading"),
    outcomesHeading: tCat("outcomesHeading"),
    faqHeading: tCat("faqHeading"),
  };
  // Localized "Home" root for the breadcrumb trail; the page's own H1 is the leaf.
  const homeLabel = (await getTranslations("Marketing.breadcrumb"))("home");
  const breadcrumbs = [
    { name: homeLabel, path: "/" },
    { name: category.heading, path: `/${category.slug}` },
  ];
  // Per-request CSP nonce (minted in proxy.ts) so the JSON-LD block is trusted under
  // the strict nonce policy — same source the root layout reads for the theme script.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      {/* Product structured data for rich results (#278), nonce'd like Organization. */}
      <JsonLd schema={softwareApplicationSchema()} nonce={nonce} />
      {/* Site-hierarchy trail (Home → this guide) for breadcrumb rich results. */}
      <JsonLd schema={breadcrumbListSchema(locale, breadcrumbs)} nonce={nonce} />
      {/* The page's visible walkthrough, mirrored as a HowTo for answer engines. */}
      {category.walkthrough.length > 0 && (
        <JsonLd
          schema={howToSchema(
            category.heading,
            category.intro,
            category.walkthrough
          )}
          nonce={nonce}
        />
      )}
      {/* The page's visible FAQ section, mirrored as FAQPage structured data. */}
      {category.faqs.length > 0 && (
        <JsonLd schema={faqPageSchema(category.faqs)} nonce={nonce} />
      )}

      <MarketingHeader />

      <main className="flex flex-1 flex-col">
        <CategoryContent
          category={category}
          labels={labels}
          locale={locale as AppLocale}
        />
      </main>

      <SiteFooter />
    </div>
  );
}
