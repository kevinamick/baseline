import { afterEach, beforeEach, describe, expect, it } from "vitest";
import robots from "@/app/robots";

describe("robots", () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://baseline.app";
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = original;
  });

  it("allows the public surface and points at the absolute sitemap", () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rules.userAgent).toBe("*");
    expect(rules.allow).toBe("/");
    expect(r.sitemap).toBe("https://baseline.app/sitemap.xml");
  });

  it("disallows the non-localized handler trees", () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    const disallow = rules.disallow as string[];
    expect(disallow).toEqual(
      expect.arrayContaining(["/api/", "/auth/", "/ingest/"])
    );
  });

  it("disallows auth-gated areas for every locale prefix", () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    const disallow = rules.disallow as string[];
    // default locale unprefixed, es/fr prefixed
    expect(disallow).toEqual(
      expect.arrayContaining([
        "/dashboard",
        "/es/dashboard",
        "/fr/dashboard",
        "/settings",
        "/es/settings",
        "/fr/settings",
      ])
    );
  });

  it("never disallows the indexable marketing pages", () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    const disallow = rules.disallow as string[];
    for (const path of ["/pricing", "/privacy"]) {
      expect(disallow).not.toContain(path);
    }
  });
});
