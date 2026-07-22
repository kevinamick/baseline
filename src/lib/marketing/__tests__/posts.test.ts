import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  POSTS,
  POST_SLUGS,
  getPost,
  postsNewestFirst,
  type PostBlock,
  type PostSegment,
} from "@/lib/marketing/posts";

function isLinkSegment(
  segment: PostSegment
): segment is { text: string; strong?: boolean; href: string } {
  return typeof segment !== "string" && typeof segment.href === "string";
}

describe("post data", () => {
  it("ships the expected posts (#435, YouTube launch)", () => {
    expect([...POST_SLUGS]).toEqual([
      "optimizer-prompt-dogfood",
      "baseline-on-youtube",
    ]);
  });

  it("has unique, url-safe slugs", () => {
    const slugs = POSTS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("ships every post en-only (ADR-0013 first-post scope)", () => {
    for (const post of POSTS) {
      expect([...post.locales]).toEqual(["en"]);
    }
  });

  it("stamps a valid ISO publishedAt date", () => {
    for (const post of POSTS) {
      expect(post.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(new Date(post.publishedAt).getTime())).toBe(false);
    }
  });

  it("carries real prose on every post (not a thin stub)", () => {
    for (const post of POSTS) {
      expect(post.dek.length).toBeGreaterThan(0);
      expect(post.sections.length).toBeGreaterThan(0);
      for (const para of post.dek) {
        const text = para
          .map((s) => (typeof s === "string" ? s : s.text))
          .join("");
        expect(text.length).toBeGreaterThan(40);
      }
      for (const section of post.sections) {
        expect(section.heading.length).toBeGreaterThan(0);
        expect(section.blocks.length).toBeGreaterThan(0);
      }
    }
  });

  it("carries the case study's table, prompt excerpts, and both images", () => {
    const post = getPost("optimizer-prompt-dogfood")!;
    const allBlocks: PostBlock[] = post.sections.flatMap((s) => [...s.blocks]);

    const tables = allBlocks.filter((b) => b.kind === "table");
    expect(tables).toHaveLength(1);
    expect(tables[0].headers).toEqual(["Criterion", "Before", "After", "Change"]);
    expect(tables[0].rows.length).toBeGreaterThan(0);
    // The overall before/after numbers must be the real experiment numbers.
    const overallRow = tables[0].rows.find((r) => r[0] === "Overall");
    expect(overallRow).toEqual(["Overall", "0.637", "0.919", "+0.282"]);

    const preBlocks = allBlocks.filter((b) => b.kind === "pre");
    expect(preBlocks).toHaveLength(2);
    expect(preBlocks[0].text).toMatch(/helping me manually improve an AI prompt/);
    expect(preBlocks[1].text).toMatch(/proceed immediately to scoring/);

    const images = allBlocks.filter((b) => b.kind === "image");
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.src).toMatch(/^\/docs\/[a-z0-9-]+\.png$/);
      expect(image.alt.length).toBeGreaterThan(20);
      expect(
        existsSync(join(process.cwd(), "public", image.src)),
        `missing ${image.src}`
      ).toBe(true);
    }
  });

  it("links internally to the manual and automated optimization guides", () => {
    const post = getPost("optimizer-prompt-dogfood")!;
    const allSegments = post.sections
      .flatMap((s) => s.blocks)
      .flatMap((b) => {
        if (b.kind === "paragraph") return b.segments;
        if (b.kind === "list") return b.items.flat();
        return [];
      });
    const hrefs = allSegments.filter(isLinkSegment).map((s) => s.href);
    expect(hrefs).toContain("/manual-prompt-optimization");
    expect(hrefs).toContain("/prompt-optimization");
  });

  it('links "guide" in the opening sentence to the manual guide', () => {
    const post = getPost("optimizer-prompt-dogfood")!;
    const dekLinks = post.dek.flat().filter(isLinkSegment);
    expect(dekLinks).toContainEqual({
      text: "guide",
      href: "/manual-prompt-optimization",
    });
  });
});

describe("the YouTube launch post", () => {
  it("embeds the launch video and calls out the channel and the X account", () => {
    const post = getPost("baseline-on-youtube")!;
    const allBlocks: PostBlock[] = post.sections.flatMap((s) => [...s.blocks]);

    const videos = allBlocks.filter((b) => b.kind === "video");
    expect(videos).toHaveLength(1);
    expect(videos[0].videoId).toBe("ueNWzKoBEd8");
    expect(videos[0].title.length).toBeGreaterThan(20);

    const hrefs = allBlocks
      .flatMap((b) => {
        if (b.kind === "paragraph") return b.segments;
        if (b.kind === "list") return b.items.flat();
        return [];
      })
      .filter(isLinkSegment)
      .map((s) => s.href);
    expect(hrefs).toContain("https://www.youtube.com/@Baseline-u4g");
    expect(hrefs).toContain("https://x.com/baselinesam");
    expect(hrefs).toContain(
      "https://github.com/baselinelabai/prompt-optimization"
    );
    // Cross-links into both optimization guides, like the first post.
    expect(hrefs).toContain("/manual-prompt-optimization");
    expect(hrefs).toContain("/prompt-optimization");
  });

  it("lists newest-first ahead of the case study", () => {
    expect(postsNewestFirst()[0].slug).toBe("baseline-on-youtube");
  });
});

describe("getPost", () => {
  it("resolves every shipped slug", () => {
    for (const slug of POST_SLUGS) {
      expect(getPost(slug)?.slug).toBe(slug);
    }
  });
  it("returns undefined for an unknown slug", () => {
    expect(getPost("nope")).toBeUndefined();
  });
});

describe("postsNewestFirst", () => {
  it("sorts by publishedAt, most recent first", () => {
    const sorted = postsNewestFirst();
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i - 1].publishedAt >= sorted[i].publishedAt).toBe(true);
    }
  });
});
