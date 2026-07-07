import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => {
  const CATALOG: Record<string, string> = {
    heading: "Blog",
    subtitle: "Case studies and notes from building and using Baseline.",
  };
  const t = (key: string) => CATALOG[key] ?? key;
  return { getTranslations: vi.fn(async () => t) };
});

import Image, { alt, contentType, size } from "@/app/[locale]/blog/opengraph-image";

describe("blog index opengraph-image", () => {
  it("declares a 1200×630 PNG card", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
    expect(typeof alt).toBe("string");
  });

  it("renders a real PNG response", async () => {
    const res = await Image({ params: Promise.resolve({ locale: "en" }) });
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 20000);
});
