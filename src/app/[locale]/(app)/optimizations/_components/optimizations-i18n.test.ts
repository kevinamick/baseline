import { describe, it, expect } from "vitest";
import en from "../../../../../../messages/en.json";
import es from "../../../../../../messages/es.json";
import fr from "../../../../../../messages/fr.json";

// #469: the run detail panel's termination-reason callout added a new `Optimizations.
// terminationReason` subtree. en is authoritative; every other locale must carry the same key
// shape so a key added to en can't ship without its es/fr translations (mirrors the
// Settings.connections i18n parity test).

const LOCALES = { es, fr } as const;

function leafPaths(obj: unknown, prefix = ""): string[] {
  if (obj == null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe("Optimizations i18n key parity", () => {
  const enKeys = leafPaths(en.Optimizations).sort();

  for (const [locale, catalog] of Object.entries(LOCALES)) {
    it(`${locale} has every Optimizations key en defines`, () => {
      const localeKeys = new Set(leafPaths((catalog as typeof en).Optimizations));
      const missing = enKeys.filter((k) => !localeKeys.has(k));
      expect(missing, `missing in ${locale}`).toEqual([]);
    });
  }
});
