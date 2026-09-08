import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/llms.txt/route";
import { CATEGORIES } from "@/lib/marketing/categories";
import { COMPARISONS } from "@/lib/marketing/comparisons";
import { POSTS } from "@/lib/marketing/posts";

describe("llms.txt", () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://baseline.app";
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = original;
  });

  async function bodyOf(): Promise<string> {
    const response = GET();
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8"
    );
    return response.text();
  }

  it("opens with the brand heading and site summary blockquote", async () => {
    const body = await bodyOf();
    expect(body.startsWith("# Baseline\n\n> ")).toBe(true);
  });

  it("lists every marketing page with its absolute canonical URL", async () => {
    const body = await bodyOf();
    for (const c of CATEGORIES) {
      expect(body).toContain(`(https://baseline.app/${c.slug})`);
    }
    for (const c of COMPARISONS) {
      expect(body).toContain(`(https://baseline.app/compare/${c.slug})`);
    }
    for (const p of POSTS) {
      expect(body).toContain(`(https://baseline.app/blog/${p.slug})`);
    }
    for (const path of ["/docs", "/privacy"]) {
      expect(body).toContain(`(https://baseline.app${path})`);
    }
  });

  it("strips the '| Baseline' branding suffix from page titles", async () => {
    const body = await bodyOf();
    expect(body).not.toMatch(/\| Baseline\]/);
  });

  it("keeps auth-utility and app routes out of the agent map", async () => {
    const body = await bodyOf();
    for (const path of ["/sign-in", "/sign-up", "/dashboard", "/settings"]) {
      expect(body).not.toContain(path);
    }
  });
});
