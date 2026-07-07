import { describe, it, expect } from "vitest";
import en from "../../../../messages/en.json";
import es from "../../../../messages/es.json";
import fr from "../../../../messages/fr.json";

// #448: the GA4 cookie-table entries (_ga / _ga_*, cookiePurpose.googleAnalytics)
// added new keys under Privacy. en is authoritative; es/fr must carry the same
// key shape so the privacy page never falls back to a raw key path or a
// missing-message error for a locale visitor. Same pattern as
// connections-i18n.test.ts.

const LOCALES = { es, fr } as const;

// Flatten a nested message object to its dot-path leaf keys.
function leafPaths(obj: unknown, prefix = ""): string[] {
  if (obj == null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe("Privacy i18n key parity (#448)", () => {
  const enKeys = leafPaths(en.Privacy).sort();

  for (const [locale, catalog] of Object.entries(LOCALES)) {
    it(`${locale} has every Privacy key en defines`, () => {
      const localeKeys = new Set(leafPaths((catalog as typeof en).Privacy));
      const missing = enKeys.filter((k) => !localeKeys.has(k));
      expect(missing, `missing in ${locale}`).toEqual([]);
    });
  }
});
