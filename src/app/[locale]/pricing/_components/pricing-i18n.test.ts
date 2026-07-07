import { describe, it, expect } from "vitest";
import en from "../../../../../messages/en.json";
import es from "../../../../../messages/es.json";
import fr from "../../../../../messages/fr.json";

// #428: the plan-mismatch forfeit-warning dialog added a new Pricing.mismatch
// namespace. en is authoritative; every other locale must carry the same key
// shape so a key added to en can't ship without its es/fr translations.

const LOCALES = { es, fr } as const;

function leafPaths(obj: unknown, prefix = ""): string[] {
  if (obj == null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe("Pricing i18n key parity (#428)", () => {
  const enKeys = leafPaths(en.Pricing).sort();

  for (const [locale, catalog] of Object.entries(LOCALES)) {
    it(`${locale} has every Pricing key en defines`, () => {
      const localeKeys = new Set(leafPaths((catalog as typeof en).Pricing));
      const missing = enKeys.filter((k) => !localeKeys.has(k));
      expect(missing, `missing in ${locale}`).toEqual([]);
    });
  }
});
