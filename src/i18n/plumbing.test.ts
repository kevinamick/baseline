import { describe, it, expect } from "vitest";
import { locales, defaultLocale, type AppLocale } from "./routing";
import { localizedPath, buildAlternates } from "./metadata";

// #242: adding a locale must be a const-list-and-catalog operation, with no
// per-locale code edits. These tests pin that the path/hreflang plumbing is a
// pure function of `locales`/`defaultLocale` — never special-cased to en/es —
// by exercising it with throwaway locales not in the list.

describe("i18n plumbing derives from the locale const list (#242)", () => {
  it("leaves the default locale unprefixed and prefixes any other locale generically", () => {
    expect(localizedPath(defaultLocale, "/pricing")).toBe("/pricing");
    expect(localizedPath(defaultLocale, "/")).toBe("/");

    // Generic for ANY non-default locale, including ones not in the list —
    // proves the prefix rule isn't hardcoded to the shipped locales.
    for (const fake of ["es", "fr", "de", "zz"] as AppLocale[]) {
      if (fake === defaultLocale) continue;
      expect(localizedPath(fake, "/pricing")).toBe(`/${fake}/pricing`);
      expect(localizedPath(fake, "/")).toBe(`/${fake}`);
    }
  });

  it("emits exactly one hreflang per supported locale plus x-default", () => {
    const alt = buildAlternates(defaultLocale, "/pricing");
    expect(Object.keys(alt.languages!).sort()).toEqual(
      ["x-default", ...locales].sort()
    );
    for (const l of locales) {
      expect(alt.languages![l]).toBe(localizedPath(l, "/pricing"));
    }
    expect(alt.languages!["x-default"]).toBe(
      localizedPath(defaultLocale, "/pricing")
    );
  });

  it("self-references the canonical per locale and falls back for an unknown one", () => {
    for (const l of locales) {
      expect(buildAlternates(l, "/pricing").canonical).toBe(
        localizedPath(l, "/pricing")
      );
    }
    // A locale outside the list doesn't throw or special-case; it falls back to
    // the default canonical while still advertising every real locale.
    const alt = buildAlternates("zz", "/pricing");
    expect(alt.canonical).toBe(localizedPath(defaultLocale, "/pricing"));
    expect(Object.keys(alt.languages!).sort()).toEqual(
      ["x-default", ...locales].sort()
    );
  });
});
