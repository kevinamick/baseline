/**
 * Analytics-consent state, shared by the client banner (which records the
 * choice) and instrumentation-client.ts (which gates PostHog + Sentry on it).
 *
 * Posture: analytics (product analytics + error/session-replay monitoring) are
 * ON by default and the visitor can opt out. So the absence of this cookie
 * means "no choice yet" → analytics allowed, and only an explicit "rejected"
 * turns them off. "accepted" is remembered so we stop asking. (Opt-out is a
 * deliberate product/legal choice — some jurisdictions require opt-in.)
 *
 * The cookie is intentionally NOT httpOnly — instrumentation-client.ts reads it
 * from `document.cookie` in the browser before any React renders. It carries no
 * secret; it's a yes/no the user set themselves.
 */

// Single source for the choice set; the union type is derived, never duplicated.
export const CONSENT_CHOICES = ["accepted", "rejected"] as const;
export type ConsentChoice = (typeof CONSENT_CHOICES)[number];

export const CONSENT_COOKIE = "analytics_consent";

// One year — long enough that we don't re-prompt a returning visitor, short
// enough to count as a periodic re-confirmation of consent.
const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function isConsentChoice(value: string | undefined): value is ConsentChoice {
  return !!value && (CONSENT_CHOICES as readonly string[]).includes(value);
}

/**
 * Parse the consent choice out of a raw `document.cookie` string. Returns null
 * when no valid choice is present (first visit, or a tampered value).
 */
export function parseConsent(cookieString: string): ConsentChoice | null {
  const match = cookieString
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CONSENT_COOKIE}=`));
  if (!match) return null;
  const value = decodeURIComponent(match.slice(CONSENT_COOKIE.length + 1));
  return isConsentChoice(value) ? value : null;
}

/** The visitor's current choice, read from the browser. SSR-safe (returns null). */
export function readConsent(): ConsentChoice | null {
  if (typeof document === "undefined") return null;
  return parseConsent(document.cookie);
}

/**
 * Whether non-essential analytics may run. Opt-out posture: allowed unless the
 * visitor has explicitly rejected (no choice yet still counts as allowed).
 */
export function analyticsAllowed(): boolean {
  return readConsent() !== "rejected";
}

/** Persist the visitor's choice to a first-party, SameSite=Lax cookie. */
export function writeConsent(choice: ConsentChoice): void {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${CONSENT_COOKIE}=${choice}; Path=/; Max-Age=${CONSENT_MAX_AGE_SECONDS}` +
    `; SameSite=Lax${secure}`;
}
