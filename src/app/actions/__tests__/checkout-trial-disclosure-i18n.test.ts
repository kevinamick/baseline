import { describe, it, expect } from "vitest";
import en from "../../../../messages/en.json";
import es from "../../../../messages/es.json";
import fr from "../../../../messages/fr.json";

// #449: the Stripe Checkout custom_text disclosure lives in the catalogs
// (Billing.trialDisclosure), same discipline as Billing.runGate
// (run-gate-i18n.test.ts) — en is authoritative and es/fr must carry the
// same key shape, since a missing key would ship the raw key path straight
// onto the Checkout page collecting the card.

const LOCALES = { es, fr } as const;

function leafPaths(obj: unknown, prefix = ""): string[] {
  if (obj == null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe("Billing.trialDisclosure i18n key parity (#449)", () => {
  const enKeys = leafPaths(en.Billing.trialDisclosure).sort();

  it("en defines the disclosure message", () => {
    expect(enKeys).toEqual(["message"]);
  });

  for (const [locale, catalog] of Object.entries(LOCALES)) {
    it(`${locale} has every Billing.trialDisclosure key en defines`, () => {
      const localeKeys = new Set(
        leafPaths((catalog as typeof en).Billing.trialDisclosure),
      );
      const missing = enKeys.filter((k) => !localeKeys.has(k));
      expect(missing, `missing in ${locale}`).toEqual([]);
    });
  }
});
