import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/navigation", () => ({
  Link: () => null,
}));
// The page renders <MarketingHeader/>, which imports getAuthContext →
// `server-only` (throws outside a server bundle). This suite only exercises
// generateMetadata, so stub the header to keep that chain out of the module.
vi.mock("@/app/_components/marketing-header", () => ({ MarketingHeader: () => null }));

// The index's generateMetadata reads its title/description from the
// Marketing.blog catalog (unlike the category/comparison/post pages, whose
// meta strings live in their data files) — echo i18n keys so this doesn't need
// a request-scoped next-intl config, same pattern as onboarding/page.test.ts.
vi.mock("next-intl/server", () => {
  const CATALOG: Record<string, string> = {
    metaTitle: "Blog — Baseline",
    metaDescription: "Stories and case studies from building and using Baseline.",
  };
  const t = (key: string) => CATALOG[key] ?? key;
  return { getTranslations: vi.fn(async () => t) };
});

import { generateMetadata } from "@/app/[locale]/blog/page";

describe("blog index page generateMetadata", () => {
  it("emits the full en/es/fr hreflang cluster (tri-lingual index chrome)", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ locale: "en" }) });
    expect(meta.title).toMatch(/Blog/);
    expect(meta.alternates).toEqual({
      canonical: "/blog",
      languages: {
        "x-default": "/blog",
        en: "/blog",
        es: "/es/blog",
        fr: "/fr/blog",
      },
    });
  });

  it("self-canonicals for es", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ locale: "es" }) });
    expect(meta.alternates?.canonical).toBe("/es/blog");
  });
});
