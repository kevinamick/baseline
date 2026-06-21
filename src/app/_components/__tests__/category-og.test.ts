import { describe, expect, it } from "vitest";
import {
  categoryOgAlt,
  categoryOgContentType,
  categoryOgSize,
  renderCategoryOgImage,
} from "@/app/_components/category-og";

describe("category opengraph-image", () => {
  it("declares a 1200×630 PNG card", () => {
    expect(categoryOgSize).toEqual({ width: 1200, height: 630 });
    expect(categoryOgContentType).toBe("image/png");
    expect(typeof categoryOgAlt).toBe("string");
  });

  it("renders a real PNG response for a known category", async () => {
    // Exercises the actual next/og + satori render path — a broken template fails here.
    const res = await renderCategoryOgImage(
      "llm-evaluation",
      Promise.resolve({ locale: "en" })
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG magic number: 0x89 'P' 'N' 'G'.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 20000);

  it("404s a locale the category does not exist in", async () => {
    await expect(
      renderCategoryOgImage("llm-evaluation", Promise.resolve({ locale: "es" }))
    ).rejects.toThrow();
  });

  it("renders a PNG for a #279 non-technical lander", async () => {
    const res = await renderCategoryOgImage(
      "reduce-ai-hallucinations",
      Promise.resolve({ locale: "en" })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 20000);
});
