import { describe, expect, it } from "vitest";
import Image, {
  alt,
  contentType,
  size,
  generateStaticParams,
} from "@/app/[locale]/compare/[competitor]/opengraph-image";

describe("comparison opengraph-image", () => {
  it("declares a 1200×630 PNG card", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
    expect(typeof alt).toBe("string");
  });

  it("prerenders for exactly the same locale/slug set as the page (ADR-0013)", () => {
    expect(generateStaticParams({ params: { locale: "en" } })).toEqual([
      { competitor: "braintrust" },
      { competitor: "langsmith" },
      { competitor: "humanloop" },
      { competitor: "langfuse" },
    ]);
    expect(generateStaticParams({ params: { locale: "es" } })).toEqual([]);
  });

  it("exposes a default image generator", () => {
    expect(typeof Image).toBe("function");
  });

  it("renders a real PNG response for a known competitor", async () => {
    // Exercises the actual next/og + satori render path (the one piece a unit
    // test can cover without a full build), so a broken template fails here.
    const res = await Image({
      params: Promise.resolve({ locale: "en", competitor: "braintrust" }),
    });
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG magic number: 0x89 'P' 'N' 'G'.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 20000);
});
