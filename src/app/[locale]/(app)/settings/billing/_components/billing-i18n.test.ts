import { describe, it, expect } from "vitest";
import en from "../../../../../../../messages/en.json";
import es from "../../../../../../../messages/es.json";
import fr from "../../../../../../../messages/fr.json";

// #428: the pending Access Code benefit notice added new keys under
// Settings.billing.plan. en is authoritative; every other locale must carry
// the same key shape so a key added to en can't ship without its es/fr
// translations (a missing key renders the raw key path, or throws, at
// runtime — see AGENTS.md's i18n section).

const LOCALES = { es, fr } as const;

function leafPaths(obj: unknown, prefix = ""): string[] {
  if (obj == null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe("Settings.billing i18n key parity (#428)", () => {
  const enKeys = leafPaths(en.Settings.billing).sort();

  for (const [locale, catalog] of Object.entries(LOCALES)) {
    it(`${locale} has every Settings.billing key en defines`, () => {
      const localeKeys = new Set(
        leafPaths((catalog as typeof en).Settings.billing),
      );
      const missing = enKeys.filter((k) => !localeKeys.has(k));
      expect(missing, `missing in ${locale}`).toEqual([]);
    });
  }
});
