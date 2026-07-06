import { describe, it, expect } from "vitest";
import en from "../../../messages/en.json";
import es from "../../../messages/es.json";
import fr from "../../../messages/fr.json";

// #425: the launch-phase Access Code gate added two Auth keys
// (signUpGatedNotice / signUpGatedMessage) to the sign-up form. en is
// authoritative for copy; es/fr must carry the same key shape so a key added
// to en can't ship without its translations (the connections-i18n.test.ts
// pattern, applied to the Auth namespace).

const LOCALES = { es, fr } as const;

// Flatten a nested message object to its dot-path leaf keys.
function leafPaths(obj: unknown, prefix = ""): string[] {
  if (obj == null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe("Auth i18n key parity (#425)", () => {
  const enKeys = leafPaths(en.Auth).sort();

  for (const [locale, catalog] of Object.entries(LOCALES)) {
    it(`${locale} has every Auth key en defines`, () => {
      const localeKeys = new Set(leafPaths((catalog as typeof en).Auth));
      const missing = enKeys.filter((k) => !localeKeys.has(k));
      expect(missing, `missing in ${locale}`).toEqual([]);
    });
  }
});
