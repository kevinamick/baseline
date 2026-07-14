import { describe, expect, it, vi } from "vitest";

// category-route imports next-intl's locale-aware navigation (`Link`), whose
// `createNavigation` can't resolve `next/navigation` under vitest — stub it, as the
// repo's other page/component tests do. We only call the pure metadata helper here.
vi.mock("@/i18n/navigation", () => ({ Link: () => null }));
// The page renders <MarketingHeader/>, which imports getAuthContext →
// `server-only` (throws outside a server bundle). This suite only exercises the
// pure metadata helper, so stub the header to keep that chain out of the module.
vi.mock("@/app/_components/marketing-header", () => ({ MarketingHeader: () => null }));

import { categoryMetadata } from "@/app/_components/category-route";

describe("categoryMetadata", () => {
  it("emits a self-canonical and the full en/es/fr hreflang cluster (localized #280)", async () => {
    const meta = await categoryMetadata(
      "llm-evaluation",
      Promise.resolve({ locale: "en" })
    );
    expect(meta.title).toMatch(/LLM Evaluation/);
    expect(meta.alternates).toEqual({
      canonical: "/llm-evaluation",
      languages: {
        "x-default": "/llm-evaluation",
        en: "/llm-evaluation",
        es: "/es/llm-evaluation",
        fr: "/fr/llm-evaluation",
      },
    });
  });

  it("self-canonicals per locale and serves localized metadata for es/fr (#280)", async () => {
    const es = await categoryMetadata(
      "llm-evaluation",
      Promise.resolve({ locale: "es" })
    );
    // Spanish title (localized), canonical points at the es path.
    expect(es.title).toMatch(/Evaluación de LLM/);
    expect(es.alternates?.canonical).toBe("/es/llm-evaluation");
    expect(es.alternates?.languages).toMatchObject({
      "x-default": "/llm-evaluation",
      es: "/es/llm-evaluation",
      fr: "/fr/llm-evaluation",
    });
  });

  it("404s a locale the category does not exist in (ADR-0013)", async () => {
    await expect(
      categoryMetadata("llm-evaluation", Promise.resolve({ locale: "de" }))
    ).rejects.toThrow();
  });

  it("404s an unknown slug", async () => {
    await expect(
      categoryMetadata("nope", Promise.resolve({ locale: "en" }))
    ).rejects.toThrow();
  });

  // The #279 non-technical landers reuse the same helper/template; confirm the
  // wiring resolves and emits the cluster like the category pages.
  it.each([
    ["reduce-ai-hallucinations", /Hallucinations/],
    ["ai-agent-testing", /Agent Testing/],
  ])("emits the hreflang cluster for the #279 lander /%s", async (slug, titleRe) => {
    const meta = await categoryMetadata(slug, Promise.resolve({ locale: "en" }));
    expect(meta.title).toMatch(titleRe);
    expect(meta.alternates).toEqual({
      canonical: `/${slug}`,
      languages: {
        "x-default": `/${slug}`,
        en: `/${slug}`,
        es: `/es/${slug}`,
        fr: `/fr/${slug}`,
      },
    });
  });
});
