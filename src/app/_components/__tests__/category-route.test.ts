import { describe, expect, it, vi } from "vitest";

// category-route imports next-intl's locale-aware navigation (`Link`), whose
// `createNavigation` can't resolve `next/navigation` under vitest — stub it, as the
// repo's other page/component tests do. We only call the pure metadata helper here.
vi.mock("@/i18n/navigation", () => ({ Link: () => null }));

import { categoryMetadata } from "@/app/_components/category-route";

describe("categoryMetadata", () => {
  it("emits a self-canonical and no es/fr hreflang for an en category", async () => {
    const meta = await categoryMetadata(
      "llm-evaluation",
      Promise.resolve({ locale: "en" })
    );
    expect(meta.title).toMatch(/LLM Evaluation/);
    expect(meta.alternates).toEqual({ canonical: "/llm-evaluation" });
  });

  it("404s a locale the category does not exist in (ADR-0013)", async () => {
    await expect(
      categoryMetadata("llm-evaluation", Promise.resolve({ locale: "es" }))
    ).rejects.toThrow();
  });

  it("404s an unknown slug", async () => {
    await expect(
      categoryMetadata("nope", Promise.resolve({ locale: "en" }))
    ).rejects.toThrow();
  });

  // The #279 non-technical landers reuse the same helper/template; confirm the
  // wiring resolves and self-canonicals like the category pages.
  it.each([
    ["reduce-ai-hallucinations", /Hallucinations/],
    ["ai-agent-testing", /Agent Testing/],
  ])("self-canonicals the #279 lander /%s", async (slug, titleRe) => {
    const meta = await categoryMetadata(slug, Promise.resolve({ locale: "en" }));
    expect(meta.title).toMatch(titleRe);
    expect(meta.alternates).toEqual({ canonical: `/${slug}` });
  });
});
