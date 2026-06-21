import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultOpenGraph,
  defaultTwitter,
  googleVerification,
  noindex,
} from "@/lib/seo";

describe("noindex", () => {
  it("keeps the page out of the index but follows links", () => {
    expect(noindex.robots).toEqual({ index: false, follow: true });
  });
});

describe("defaultOpenGraph", () => {
  it("builds a website card with localized url and OG locale (default locale unprefixed)", () => {
    expect(defaultOpenGraph("en", "/", "Baseline", "desc")).toEqual({
      type: "website",
      siteName: "Baseline",
      title: "Baseline",
      description: "desc",
      url: "/",
      locale: "en_US",
    });
  });

  it("prefixes non-default locales and maps the OG locale", () => {
    const og = defaultOpenGraph("es", "/pricing", "Precios", "desc");
    expect(og.url).toBe("/es/pricing");
    expect(og.locale).toBe("es_ES");
  });

  it("falls back to the default locale form for an unknown locale", () => {
    const og = defaultOpenGraph("de", "/", "Baseline", "desc");
    expect(og.url).toBe("/");
    expect(og.locale).toBe("en_US");
  });
});

describe("defaultTwitter", () => {
  it("builds a large-image summary card", () => {
    expect(defaultTwitter("Baseline", "desc")).toEqual({
      card: "summary_large_image",
      title: "Baseline",
      description: "desc",
    });
  });
});

describe("googleVerification", () => {
  const original = process.env.GOOGLE_SITE_VERIFICATION;
  beforeEach(() => {
    delete process.env.GOOGLE_SITE_VERIFICATION;
  });
  afterEach(() => {
    process.env.GOOGLE_SITE_VERIFICATION = original;
  });

  it("is undefined when the token env is unset", () => {
    expect(googleVerification()).toBeUndefined();
  });

  it("emits the google token when set", () => {
    process.env.GOOGLE_SITE_VERIFICATION = "tok123";
    expect(googleVerification()).toEqual({ google: "tok123" });
  });
});
