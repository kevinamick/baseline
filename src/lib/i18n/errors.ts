import "server-only";
import { createTranslator } from "next-intl";
import { getTranslations } from "next-intl/server";
import enMessages from "../../../messages/en.json";

/**
 * The action-layer counterpart to `localizeRunGateError`
 * (`src/lib/billing/run-gate.ts`): server actions run inside a request, so
 * `getTranslations` normally resolves the caller's locale — but a node unit
 * test that calls an action directly has no next-intl request scope, so this
 * falls back to the English-rendered copy instead of throwing (#407).
 */

type ErrorsCatalog = (typeof enMessages)["Errors"];

export async function localizeError<S extends keyof ErrorsCatalog>(
  scope: S,
  key: keyof ErrorsCatalog[S] & string,
  params?: Record<string, string | number>
): Promise<string> {
  const namespace = `Errors.${String(scope)}`;
  try {
    const t = await getTranslations(namespace);
    return t(key, params);
  } catch {
    const t = createTranslator({ locale: "en", messages: enMessages, namespace });
    return t(key, params);
  }
}
