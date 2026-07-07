import "server-only";
import { cookies } from "next/headers";
import { CONSENT_COOKIE, isConsentChoice } from "@/lib/consent/cookie";

/**
 * Server-side mirror of `analyticsAllowed()` (cookie.ts), which reads
 * `document.cookie` in the browser. Some consent-gated surfaces — the Google
 * Analytics loader tag (#448) — render as a Server Component and must decide
 * whether to emit the tag AT ALL before any HTML reaches the browser, so an
 * unconsented visitor's response never contains the tag (and therefore never
 * issues the request) rather than relying on client-side JS to suppress it.
 *
 * The `analytics_consent` cookie is intentionally not httpOnly (see cookie.ts),
 * so it's readable here via next/headers `cookies()` same as any other
 * first-party cookie.
 */
export async function analyticsAllowedOnServer(): Promise<boolean> {
  const value = (await cookies()).get(CONSENT_COOKIE)?.value;
  return isConsentChoice(value) && value === "accepted";
}
