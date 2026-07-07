import { describe, expect, it } from "vitest";
import Image, {
  alt,
  contentType,
  size,
} from "@/app/[locale]/blog/[slug]/opengraph-image";

describe("blog post opengraph-image", () => {
  it("declares a 1200×630 PNG card", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
    expect(typeof alt).toBe("string");
  });

  it("renders a real PNG response for the shipped post", async () => {
    const res = await Image({
      params: Promise.resolve({
        locale: "en",
        slug: "optimizer-prompt-dogfood",
      }),
    });
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG magic number: 0x89 'P' 'N' 'G'.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 20000);

  it("404s a locale the post does not exist in yet", async () => {
    await expect(
      Image({
        params: Promise.resolve({
          locale: "es",
          slug: "optimizer-prompt-dogfood",
        }),
      })
    ).rejects.toThrow();
  });

  it("404s an unknown slug", async () => {
    await expect(
      Image({ params: Promise.resolve({ locale: "en", slug: "nope" }) })
    ).rejects.toThrow();
  });
});
