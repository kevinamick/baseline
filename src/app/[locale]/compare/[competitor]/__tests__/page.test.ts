import { describe, expect, it, vi } from "vitest";

// The page imports next-intl's locale-aware navigation (`Link`), whose
// `createNavigation` can't resolve `next/navigation` under vitest — stub it, as
// the repo's other page/component tests do. We only call the page's pure server
// helpers here, which don't touch navigation anyway.
vi.mock("@/i18n/navigation", () => ({
  Link: () => null,
}));
// The page renders <MarketingHeader/>, which imports getAuthContext →
// `server-only` (throws outside a server bundle). This suite only exercises
// generateMetadata, so stub the header to keep that chain out of the module.
vi.mock("@/app/_components/marketing-header", () => ({ MarketingHeader: () => null }));

import { generateMetadata } from "@/app/[locale]/compare/[competitor]/page";

// The page is dynamically rendered (no generateStaticParams — the nonce-CSP
// layout forces dynamic). ADR-0013's locale-set enforcement lives in the
// notFound() guard, exercised below via generateMetadata.
describe("compare page generateMetadata", () => {
  it("emits a self-canonical and the full en/es/fr hreflang cluster (localized #280)", async () => {
    const meta = await generateMetadata({
      params: Promise.resolve({ locale: "en", competitor: "braintrust" }),
    });
    expect(meta.title).toMatch(/Braintrust/);
    expect(meta.alternates).toEqual({
      canonical: "/compare/braintrust",
      languages: {
        "x-default": "/compare/braintrust",
        en: "/compare/braintrust",
        es: "/es/compare/braintrust",
        fr: "/fr/compare/braintrust",
      },
    });
  });

  it("serves localized metadata and an es-canonical for the es page (#280)", async () => {
    const meta = await generateMetadata({
      params: Promise.resolve({ locale: "es", competitor: "braintrust" }),
    });
    // Competitor proper noun is retained; the rest of the title is Spanish.
    expect(meta.title).toMatch(/evaluación de LLM/i);
    expect(meta.alternates?.canonical).toBe("/es/compare/braintrust");
  });

  it("404s a locale the comparison does not exist in", async () => {
    await expect(
      generateMetadata({
        params: Promise.resolve({ locale: "de", competitor: "braintrust" }),
      })
    ).rejects.toThrow();
  });

  it("404s an unknown competitor", async () => {
    await expect(
      generateMetadata({
        params: Promise.resolve({ locale: "en", competitor: "nope" }),
      })
    ).rejects.toThrow();
  });
});
