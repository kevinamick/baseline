import { describe, it, expect } from "vitest";
import en from "../../../../../../../messages/en.json";
import es from "../../../../../../../messages/es.json";
import fr from "../../../../../../../messages/fr.json";

// #363: the Connections settings dialogs (Add / Edit Modules / Edit prompt /
// Delete) call keys under Settings.connections and Settings.connections.create.
// Keys missing from a locale rendered the raw key path (or a missing-message
// error) in the UI — exactly the bug this fixes. en is authoritative; every
// other locale must carry the same key shape for this subtree so a key added to
// en for a new field can't ship without its es/fr translations.

const LOCALES = { es, fr } as const;

// Flatten a nested message object to its dot-path leaf keys (plurals/ICU live in
// the leaf string, so we compare structure, not copy).
function leafPaths(obj: unknown, prefix = ""): string[] {
  if (obj == null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe("Settings.connections i18n key parity (#363)", () => {
  const enKeys = leafPaths(en.Settings.connections).sort();

  for (const [locale, catalog] of Object.entries(LOCALES)) {
    it(`${locale} has every Settings.connections key en defines`, () => {
      const localeKeys = new Set(
        leafPaths((catalog as typeof en).Settings.connections),
      );
      const missing = enKeys.filter((k) => !localeKeys.has(k));
      expect(missing, `missing in ${locale}`).toEqual([]);
    });
  }
});
