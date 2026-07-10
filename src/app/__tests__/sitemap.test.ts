import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sitemap from "@/app/sitemap";

describe("sitemap", () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://baseline.app";
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = original;
  });

  it("lists the funnel pages plus the marketing surface (no auth-utility pages)", () => {
    const urls = sitemap().map((e) => e.url);
    expect(urls).toEqual([
      "https://baseline.app",
      "https://baseline.app/pricing",
      "https://baseline.app/privacy",
      "https://baseline.app/compare/braintrust",
      "https://baseline.app/compare/langsmith",
      "https://baseline.app/compare/humanloop",
      "https://baseline.app/compare/langfuse",
      "https://baseline.app/llm-evaluation",
      "https://baseline.app/llm-as-judge",
      "https://baseline.app/prompt-optimization",
      "https://baseline.app/rubric-based-evaluation",
      "https://baseline.app/reduce-ai-hallucinations",
      "https://baseline.app/ai-agent-testing",
      "https://baseline.app/simple-prompt-optimization",
      "https://baseline.app/ai-eval-pricing",
      "https://baseline.app/manual-prompt-optimization",
      "https://baseline.app/docs",
      "https://baseline.app/blog",
      "https://baseline.app/blog/optimizer-prompt-dogfood",
    ]);
    expect(urls.some((u) => u.includes("sign-in") || u.includes("sign-up"))).toBe(
      false
    );
  });

  it("registers every category lander with the full en/es/fr hreflang cluster (localized #280)", () => {
    for (const slug of [
      "llm-evaluation",
      "llm-as-judge",
      "prompt-optimization",
      "rubric-based-evaluation",
      "reduce-ai-hallucinations",
      "ai-agent-testing",
      "simple-prompt-optimization",
      "ai-eval-pricing",
      "manual-prompt-optimization",
    ]) {
      const category = sitemap().find((e) => e.url.endsWith(`/${slug}`));
      // Canonical loc stays en (unprefixed); the cluster covers all three locales.
      expect(category?.url).toBe(`https://baseline.app/${slug}`);
      expect(category?.alternates?.languages).toEqual({
        "x-default": `https://baseline.app/${slug}`,
        en: `https://baseline.app/${slug}`,
        es: `https://baseline.app/es/${slug}`,
        fr: `https://baseline.app/fr/${slug}`,
      });
      expect(category?.priority).toBe(0.8);
    }
  });

  it("registers every comparison with the full en/es/fr hreflang cluster (localized #280)", () => {
    for (const slug of ["braintrust", "langsmith", "humanloop", "langfuse"]) {
      const compare = sitemap().find((e) =>
        e.url.endsWith(`/compare/${slug}`)
      );
      expect(compare?.url).toBe(`https://baseline.app/compare/${slug}`);
      expect(compare?.alternates?.languages).toEqual({
        "x-default": `https://baseline.app/compare/${slug}`,
        en: `https://baseline.app/compare/${slug}`,
        es: `https://baseline.app/es/compare/${slug}`,
        fr: `https://baseline.app/fr/compare/${slug}`,
      });
      expect(compare?.priority).toBe(0.7);
    }
  });

  it("registers the /blog index tri-lingually and the first post en-only (#435)", () => {
    const index = sitemap().find((e) => e.url === "https://baseline.app/blog");
    expect(index?.alternates?.languages).toEqual({
      "x-default": "https://baseline.app/blog",
      en: "https://baseline.app/blog",
      es: "https://baseline.app/es/blog",
      fr: "https://baseline.app/fr/blog",
    });
    expect(index?.priority).toBe(0.6);

    const post = sitemap().find((e) =>
      e.url.endsWith("/blog/optimizer-prompt-dogfood")
    );
    expect(post?.url).toBe(
      "https://baseline.app/blog/optimizer-prompt-dogfood"
    );
    // Single-locale post: no hreflang cluster (ADR-0013 first-post scope).
    expect(post?.alternates).toBeUndefined();
    expect(post?.priority).toBe(0.6);
  });

  it("uses absolute URLs for every entry", () => {
    for (const entry of sitemap()) {
      expect(entry.url).toMatch(/^https:\/\/baseline\.app/);
    }
  });

  it("stamps every entry with a real content `lastmod` (the hint Google reads)", () => {
    for (const entry of sitemap()) {
      expect(entry.lastModified, entry.url).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // Posts date from their own publishedAt; the /blog index moves with the
    // newest post, since a new post is what changes the index.
    const post = sitemap().find((e) =>
      e.url.endsWith("/blog/optimizer-prompt-dogfood")
    );
    expect(post?.lastModified).toBe("2026-07-06");
    const index = sitemap().find((e) => e.url === "https://baseline.app/blog");
    expect(index?.lastModified).toBe("2026-07-06");
  });

  it("emits hreflang alternates (en/es/fr + x-default) with correct prefixes", () => {
    const pricing = sitemap().find((e) => e.url.endsWith("/pricing"));
    expect(pricing?.alternates?.languages).toEqual({
      "x-default": "https://baseline.app/pricing",
      en: "https://baseline.app/pricing",
      es: "https://baseline.app/es/pricing",
      fr: "https://baseline.app/fr/pricing",
    });
  });

  it("keeps the home root unprefixed across locales", () => {
    const home = sitemap().find((e) => e.url === "https://baseline.app");
    expect(home?.alternates?.languages).toEqual({
      "x-default": "https://baseline.app",
      en: "https://baseline.app",
      es: "https://baseline.app/es",
      fr: "https://baseline.app/fr",
    });
    expect(home?.priority).toBe(1);
  });
});
