import { describe, it, expect } from "vitest";
import en from "../../../../messages/en.json";
import es from "../../../../messages/es.json";
import fr from "../../../../messages/fr.json";

// The action-layer error catalog (#407): every server action that used to return
// a hardcoded English sentence now renders it through `localizeError` against
// `Errors.<scope>` in the catalogs, so a key missing from a locale would surface
// the raw key path in a form/toast. en is authoritative; es/fr must carry the
// same key shape for every scope under `Errors` (same guard as
// connections-i18n.test.ts / run-gate-i18n.test.ts).

const LOCALES = { es, fr } as const;

function leafPaths(obj: unknown, prefix = ""): string[] {
  if (obj == null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k)
  );
}

describe("Errors i18n key parity", () => {
  const enKeys = leafPaths(en.Errors).sort();

  it("en defines the full action-error message set", () => {
    expect(enKeys.length).toBeGreaterThan(0);
  });

  for (const [locale, catalog] of Object.entries(LOCALES)) {
    it(`${locale} has every Errors key en defines`, () => {
      const localeKeys = new Set(leafPaths((catalog as typeof en).Errors));
      const missing = enKeys.filter((k) => !localeKeys.has(k));
      expect(missing, `missing in ${locale}`).toEqual([]);
    });
  }
});
