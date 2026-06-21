import { describe, expect, it } from "vitest";
import { buildAlternates, buildMarketingAlternates } from "@/i18n/metadata";

describe("buildAlternates (funnel pages)", () => {
  it("emits a self-canonical and the full hreflang cluster", () => {
    expect(buildAlternates("es", "/pricing")).toEqual({
      canonical: "/es/pricing",
      languages: {
        "x-default": "/pricing",
        en: "/pricing",
        es: "/es/pricing",
        fr: "/fr/pricing",
      },
    });
  });
});

describe("buildMarketingAlternates (per-page locale set, ADR-0013)", () => {
  it("en-only page: self-canonical, no hreflang cluster", () => {
    expect(
      buildMarketingAlternates("en", "/compare/braintrust", ["en"])
    ).toEqual({ canonical: "/compare/braintrust" });
  });

  it("emits the cluster only for the locales the page actually exists in", () => {
    // A page that later gains es (but not fr) advertises exactly en+es.
    expect(
      buildMarketingAlternates("es", "/compare/braintrust", ["en", "es"])
    ).toEqual({
      canonical: "/es/compare/braintrust",
      languages: {
        "x-default": "/compare/braintrust",
        en: "/compare/braintrust",
        es: "/es/compare/braintrust",
      },
    });
  });

  it("keeps the canonical well-defined for a locale outside the set", () => {
    // Defensive: the page 404s before this, but canonical must still resolve.
    expect(
      buildMarketingAlternates("fr", "/compare/braintrust", ["en"])
    ).toEqual({ canonical: "/compare/braintrust" });
  });
});
