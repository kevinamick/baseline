import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Append-only ledger GRANT guard (ADR-0009).
 *
 * point_ledger, optimization_run_ledger and managed_spend_ledger are append-only
 * by REVOKE, not just convention: each migration revokes update/delete/truncate
 * from `service_role` (the RLS-bypassing role the app runs as), so a "settle"/
 * "release" is a NEW row, never a mutation — the ledger a customer inspects IS the
 * audit trail (ADR-0008's transparency principle).
 *
 * That invariant regressed once already: 20260614's bulk
 * `grant ... update, delete on all tables ... to service_role` silently re-granted
 * the write verbs, and it slipped through because this kind of check only runs
 * against a real database — which the `test-app` CI job (plain `vitest run`, no
 * Supabase env) doesn't have. The fix migration (20260615) re-revoked them; this
 * test is the standing guard so the same bulk-grant (or a new append-only ledger
 * that forgets its revoke) can't regress it silently again. It is wired into the
 * e2e CI job, which DOES start a local Supabase (see .github/workflows/ci.yml).
 *
 * Skipped when no local Supabase env is available (so `test-app` stays green);
 * run locally with the .env.local vars exported:
 *
 *   set -a; source .env.local; set +a; npx vitest run append-only-grants.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

// A fixed id that matches no row, so update/delete never touch real ledger data —
// even in the regression case (grant present), the statement affects zero rows.
// The permission check fires BEFORE row matching, so a correctly-revoked grant
// still errors here regardless of the (empty) match.
const NO_SUCH_ID = "00000000-0000-0000-0000-000000000000";

const APPEND_ONLY_LEDGERS = [
  "point_ledger",
  "optimization_run_ledger",
  "managed_spend_ledger",
] as const;

describe.skipIf(!hasDb)("append-only ledger grants (integration)", () => {
  let db: SupabaseClient;

  beforeAll(() => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });
  });

  for (const ledger of APPEND_ONLY_LEDGERS) {
    describe(ledger, () => {
      // Positive control: service_role CAN read the ledger (the app appends + reads
      // it). This proves the table is reachable, so the update/delete denials below
      // are specifically the revoked write verbs — not the table being unreachable.
      it("allows SELECT for service_role", async () => {
        const { error } = await db.from(ledger).select("id").limit(1);
        expect(error).toBeNull();
      });

      // Assert the EXACT Postgres SQLSTATE for the denial — 42501 (insufficient_
      // privilege) — not merely "some error". `entry_type` is a real column on all
      // three ledgers, so PostgREST validates the body and reaches the privilege
      // check (a non-existent column would short-circuit with PGRST204 and mask a
      // real regression). If the write verb were re-granted, the update/delete would
      // succeed (zero rows, no error) — code would be undefined, failing this.
      it("denies UPDATE to service_role (append-only)", async () => {
        const { error } = await db
          .from(ledger)
          .update({ entry_type: "__grant_guard__" })
          .eq("id", NO_SUCH_ID);
        expect(
          error?.code,
          `service_role can UPDATE ${ledger} — append-only invariant broken (ADR-0009). ` +
            `A bulk grant likely re-granted the write verbs; re-revoke them.`,
        ).toBe("42501");
      });

      it("denies DELETE to service_role (append-only)", async () => {
        const { error } = await db.from(ledger).delete().eq("id", NO_SUCH_ID);
        expect(
          error?.code,
          `service_role can DELETE ${ledger} — append-only invariant broken (ADR-0009). ` +
            `A bulk grant likely re-granted the write verbs; re-revoke them.`,
        ).toBe("42501");
      });
    });
  }
});
