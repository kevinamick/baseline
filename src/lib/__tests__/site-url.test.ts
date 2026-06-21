import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { absoluteUrl, siteUrl } from "@/lib/site-url";

describe("site-url", () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL;
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = original;
  });

  it("falls back to localhost when NEXT_PUBLIC_APP_URL is unset", () => {
    expect(siteUrl()).toBe("http://localhost:3000");
  });

  it("uses NEXT_PUBLIC_APP_URL and strips a trailing slash", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://baseline.app/";
    expect(siteUrl()).toBe("https://baseline.app");
  });

  it("builds absolute URLs, with no double slash for the root", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://baseline.app";
    expect(absoluteUrl("/")).toBe("https://baseline.app");
    expect(absoluteUrl("/pricing")).toBe("https://baseline.app/pricing");
    expect(absoluteUrl("/sitemap.xml")).toBe("https://baseline.app/sitemap.xml");
  });
});
