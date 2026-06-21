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
    ]);
    expect(urls.some((u) => u.includes("sign-in") || u.includes("sign-up"))).toBe(
      false
    );
  });

  it("registers each comparison as an en-only entry — no hreflang cluster (ADR-0013)", () => {
    const compare = sitemap().find((e) => e.url.endsWith("/compare/braintrust"));
    // en-only page: self-canonical loc, no es/fr alternates (a one-locale
    // hreflang cluster is meaningless and risks suppression).
    expect(compare?.url).toBe("https://baseline.app/compare/braintrust");
    expect(compare?.alternates).toBeUndefined();
    expect(compare?.priority).toBe(0.7);
  });

  it("uses absolute URLs for every entry", () => {
    for (const entry of sitemap()) {
      expect(entry.url).toMatch(/^https:\/\/baseline\.app/);
    }
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
