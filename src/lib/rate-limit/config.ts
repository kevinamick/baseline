// Rate-limit thresholds — the single source of truth (#209, ADR-0010).
// Every protected surface reads its limits from here; nothing hard-codes a number
// at the call site. Slices 2/3 (other auth surfaces) reuse this table unchanged.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The surfaces a guard can protect. Single source — derive the type, never duplicate. */
export const SURFACES = [
  "signIn",
  "signUp",
  "requestPasswordReset",
  "changeEmail",
  "inviteMember",
  "authConfirm",
  "authCallback",
] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * How a counter is keyed. Unauthenticated flows key on the trusted client IP;
 * authenticated flows on the acting user/team. Auth flows that name an email are
 * dual-keyed (email + ip) so a botnet (rotating IP) and a single host hammering
 * one address are both caught.
 */
export const KEYTYPES = ["email", "ip", "user", "team"] as const;
export type Keytype = (typeof KEYTYPES)[number];

export interface RateLimitRule {
  /** Allowed attempts within the window. The (limit+1)-th attempt is blocked. */
  limit: number;
  /** Fixed-window length in milliseconds. */
  windowMs: number;
}

type SurfaceRules = Partial<Record<Keytype, RateLimitRule>>;

export const RATE_LIMITS: Record<Surface, SurfaceRules> = {
  signIn: {
    email: { limit: 5, windowMs: 15 * MINUTE },
    ip: { limit: 20, windowMs: 15 * MINUTE },
  },
  signUp: {
    ip: { limit: 5, windowMs: HOUR },
  },
  requestPasswordReset: {
    // Enumeration-sensitive: the per-email check silently drops over the limit.
    email: { limit: 3, windowMs: HOUR },
    ip: { limit: 10, windowMs: HOUR },
  },
  changeEmail: {
    user: { limit: 3, windowMs: HOUR },
  },
  inviteMember: {
    team: { limit: 20, windowMs: HOUR },
  },
  authConfirm: {
    ip: { limit: 20, windowMs: 15 * MINUTE },
  },
  authCallback: {
    ip: { limit: 20, windowMs: 15 * MINUTE },
  },
};
