import { createHash } from "node:crypto";
import type { Keytype, Surface } from "./config";

// Key derivation for the rate-limit store. Split out from the guard so the hash
// and window math are pure and directly unit/integration-testable (#209).

/**
 * Normalize an email the same way before hashing so "A@B.com" and "a@b.com "
 * share a counter. Mirrors EmailSchema's trim+lowercase.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The stored key: sha256(surface:keytype:normalized_value), hex. The raw IP or
 * email never reaches Postgres — only this digest does (GDPR: both are personal
 * data). `surface`/`keytype` are also stored cleartext, but as low-cardinality
 * tuning labels, not identifiers.
 */
export function hashKey(
  surface: Surface,
  keytype: Keytype,
  normalizedValue: string
): string {
  return createHash("sha256")
    .update(`${surface}:${keytype}:${normalizedValue}`)
    .digest("hex");
}

/**
 * The fixed-window bucket an instant falls into: now floored to a multiple of
 * windowMs, as an ISO timestamp. A new window simply produces a new key row,
 * so the count "resets" with no mutation.
 */
export function windowStart(windowMs: number, now: number = Date.now()): string {
  return new Date(Math.floor(now / windowMs) * windowMs).toISOString();
}
