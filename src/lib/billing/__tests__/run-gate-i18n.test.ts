import { describe, it, expect } from "vitest";
import en from "../../../../messages/en.json";
import es from "../../../../messages/es.json";
import fr from "../../../../messages/fr.json";

// The Run Gate's refusal copy lives in the catalogs (Billing.runGate) so every
// locale ships the same message set — the gate renders the English fallback
// itself and request-scoped callers re-render via localizeRunGateError. A key
// missing from a locale renders the raw key path in the run dialogs, so en is
// authoritative and es/fr must carry the same key shape (same guard as
// connections-i18n.test.ts, #363).

const LOCALES = { es, fr } as const;

function leafPaths(obj: unknown, prefix = ""): string[] {
  if (obj == null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe("Billing.runGate i18n key parity", () => {
  const enKeys = leafPaths(en.Billing.runGate).sort();

  it("en defines the full refusal message set", () => {
    expect(enKeys.length).toBeGreaterThan(0);
  });

  for (const [locale, catalog] of Object.entries(LOCALES)) {
    it(`${locale} has every Billing.runGate key en defines`, () => {
      const localeKeys = new Set(leafPaths((catalog as typeof en).Billing.runGate));
      const missing = enKeys.filter((k) => !localeKeys.has(k));
      expect(missing, `missing in ${locale}`).toEqual([]);
    });
  }
});
