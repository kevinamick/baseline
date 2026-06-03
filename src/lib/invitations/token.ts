import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * Invitation tokens. We mint a high-entropy random token, email the raw value
 * inside the accept URL, and persist only its sha256 hash (`token_hash`). Accept
 * re-hashes the presented token and looks the row up by hash, so the database
 * never stores a replayable secret.
 */

/** A URL-safe, 256-bit random token for the emailed accept link. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Stable sha256 hex of a token, used as the stored/looked-up `token_hash`. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
