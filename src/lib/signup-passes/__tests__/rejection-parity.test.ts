import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SIGNUP_PASS_REJECTION_MESSAGE } from "../rejection";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
  "20260712000000_signup_passes.sql"
);

/**
 * Single-source guard (the repo's enum/constant rule, #489 review C3): the
 * hook's rejection literal lives in the migration SQL, and the app matches on
 * it via `SIGNUP_PASS_REJECTION_MESSAGE` to map a hook rejection to the generic
 * refusal. If a future migration reworded the message, `isSignupPassRejection`
 * would silently stop matching and hook rejections would leak a raw error. This
 * asserts the TS constant is still present verbatim in the migration.
 */
describe("signup-pass rejection literal parity", () => {
  it("the migration SQL contains the exact SIGNUP_PASS_REJECTION_MESSAGE", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain(`'message', 'Sign-up is not available.'`);
    expect(sql).toContain(`'${SIGNUP_PASS_REJECTION_MESSAGE}'`);
  });
});
