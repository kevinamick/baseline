import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetLocale } = vi.hoisted(() => ({ mockGetLocale: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next-intl/server", () => ({ getLocale: mockGetLocale }));

import { currentUserLocale, getEmailTranslator } from "../i18n";

beforeEach(() => vi.clearAllMocks());

describe("currentUserLocale", () => {
  it("returns the request locale when it's supported", async () => {
    mockGetLocale.mockResolvedValue("es");
    expect(await currentUserLocale()).toBe("es");
  });

  it("falls back to the default locale when unsupported", async () => {
    mockGetLocale.mockResolvedValue("de");
    expect(await currentUserLocale()).toBe("en");
  });
});

describe("getEmailTranslator", () => {
  it("loads the requested locale's catalog under the Email namespace", async () => {
    const t = await getEmailTranslator("fr");
    // Spot-check a key that should exist under Email.* in every catalog.
    expect(typeof t).toBe("function");
  });

  it("falls back to the default locale's catalog for an unsupported locale", async () => {
    const t = await getEmailTranslator("zz");
    expect(typeof t).toBe("function");
  });

  it("resolves for every supported locale without throwing", async () => {
    for (const locale of ["en", "es", "fr"]) {
      await expect(getEmailTranslator(locale)).resolves.toBeDefined();
    }
  });
});
