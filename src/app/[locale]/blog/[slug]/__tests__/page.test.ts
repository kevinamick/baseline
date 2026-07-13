import { describe, expect, it, vi } from "vitest";

// The page imports next-intl's locale-aware navigation (`Link`), whose
// `createNavigation` can't resolve `next/navigation` under vitest — stub it, as
// the repo's other page/component tests do (compare/[competitor]/page.test.ts).
vi.mock("@/i18n/navigation", () => ({
  Link: () => null,
}));
// The page renders <MarketingHeader/>, which imports getAuthContext →
// `server-only` (throws outside a server bundle). This suite only exercises
// generateMetadata, so stub the header to keep that chain out of the module.
vi.mock("@/app/_components/marketing-header", () => ({ MarketingHeader: () => null }));

import { generateMetadata } from "@/app/[locale]/blog/[slug]/page";

describe("blog post page generateMetadata", () => {
  it("emits a self-canonical for the en-only post (ADR-0013 first-post scope)", async () => {
    const meta = await generateMetadata({
      params: Promise.resolve({
        locale: "en",
        slug: "optimizer-prompt-dogfood",
      }),
    });
    expect(meta.title).toMatch(/28 points better/);
    // Single-locale page: self-canonical only, no hreflang cluster (#435).
    expect(meta.alternates).toEqual({
      canonical: "/blog/optimizer-prompt-dogfood",
    });
  });

  it("404s a locale the post does not exist in yet (es/fr fast-follow)", async () => {
    await expect(
      generateMetadata({
        params: Promise.resolve({
          locale: "es",
          slug: "optimizer-prompt-dogfood",
        }),
      })
    ).rejects.toThrow();
  });

  it("404s an unknown slug", async () => {
    await expect(
      generateMetadata({
        params: Promise.resolve({ locale: "en", slug: "nope" }),
      })
    ).rejects.toThrow();
  });
});
