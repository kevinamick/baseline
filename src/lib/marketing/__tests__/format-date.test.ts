import { describe, expect, it } from "vitest";
import type { AppLocale } from "@/i18n/routing";
import { formatVerifiedDate } from "@/lib/marketing/format-date";

describe("formatVerifiedDate (#280)", () => {
  it("renders each locale's conventional long form", () => {
    expect(formatVerifiedDate("2026-06-21", "en")).toBe("June 21, 2026");
    expect(formatVerifiedDate("2026-06-21", "es")).toBe("21 de junio de 2026");
    expect(formatVerifiedDate("2026-06-21", "fr")).toBe("21 juin 2026");
  });

  it("falls back to the English form for an unknown locale", () => {
    expect(formatVerifiedDate("2026-01-05", "de" as AppLocale)).toBe(
      "January 5, 2026"
    );
  });

  it("is deterministic and ICU-independent (no toLocaleDateString drift)", () => {
    // Same input always yields the same bytes — the property the prerendered
    // <time> stamp relies on to avoid hydration mismatch.
    expect(formatVerifiedDate("2026-12-01", "fr")).toBe(
      formatVerifiedDate("2026-12-01", "fr")
    );
    expect(formatVerifiedDate("2026-12-01", "es")).toBe("1 de diciembre de 2026");
  });
});
