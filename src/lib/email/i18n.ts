import "server-only";
import { createTranslator, hasLocale } from "next-intl";
import { getLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";

/**
 * The acting user's current request locale, validated to a supported one (#247).
 *
 * Persisted into Supabase `user_metadata` at the points that trigger a
 * Supabase-sent auth email (sign-up, email change, password reauthentication) so
 * GoTrue can render those templates per-locale. Unlike the app's own mail, those
 * templates run off the app and have no access to the i18n catalogs, so the
 * recipient's locale has to travel in metadata (exposed to the template as
 * `.Data`). Falls back to the default locale, mirroring the precedence in
 * `resolveEmailLocale` (recipient preference → default) for these self-directed
 * flows where the recipient is the actor.
 */
export async function currentUserLocale(): Promise<string> {
  const locale = await getLocale();
  return hasLocale(routing.locales, locale) ? locale : routing.defaultLocale;
}

/**
 * Resolve the locale to render a transactional email in (#241). Emails are sent
 * off-request, so the locale must be decided explicitly — never from
 * `Accept-Language`. Precedence: the recipient's own known locale first, then
 * the actor who triggered the send (e.g. the inviting Contributor), then the
 * default. A brand-new invitee has no stored locale, so they get the inviter's.
 */
export function resolveEmailLocale(opts: {
  recipientLocale?: string | null;
  inviterLocale?: string | null;
}): string {
  for (const candidate of [opts.recipientLocale, opts.inviterLocale]) {
    if (candidate && hasLocale(routing.locales, candidate)) return candidate;
  }
  return routing.defaultLocale;
}

/**
 * A translator bound to a specific locale's catalog, for rendering emails off
 * the request. Unlike `getTranslations`, this needs no request context — the
 * messages are loaded explicitly — so it's safe to call from a worker or a
 * server action and is straightforward to unit-test. Unknown locales fall back
 * to the default catalog (mirroring next-intl's runtime English fallback).
 */
export async function getEmailTranslator(locale: string) {
  const resolved = hasLocale(routing.locales, locale)
    ? locale
    : routing.defaultLocale;
  const messages = (await import(`../../../messages/${resolved}.json`)).default;
  return createTranslator({ locale: resolved, messages, namespace: "Email" });
}

export type EmailTranslator = Awaited<ReturnType<typeof getEmailTranslator>>;
