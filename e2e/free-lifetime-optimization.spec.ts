import { test, expect } from "./fixtures";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONTRIBUTOR_B, makeAdminClient, readSeed } from "./constants";

/**
 * Free's ONE lifetime Optimization Run (optimizationRunsGrant "lifetime" in
 * plans.ts) against Team B — the free Team with NO seeded optimization run, so
 * its lifetime unit starts unconsumed (Team A's seeded completed run consumes
 * its unit via seeded ledger rows; optimizations.spec.ts asserts that side).
 *
 * The effective included count is derived from optimization_lifetime_used (net
 * reserves minus releases across ALL periods), so the "used" state is driven
 * here by inserting ledger rows in a synthetic PAST month — exactly the seed's
 * technique — and undone with a compensating release (the ledger is
 * append-only). Mutating phase: Team B's pill/gate is asserted by no other
 * mutating spec, but this must not race the main pool's Team B readers.
 *
 * Self-healing cleanup (#501 CR-9): the burn (test 2) and its compensating
 * release (test 3) are split across tests, and serial mode skips the rest of
 * the file the moment one test fails — so a mid-burn failure or timeout must
 * never leave Team B's lifetime unit permanently spent for the next suite
 * run. `restoreLifetimeUnit` runs unconditionally in `afterAll` and reads the
 * SAME optimization_lifetime_used() net (reserves minus releases, all-time)
 * the app reads, so it is idempotent regardless of how far the file got:
 * nothing burned → net 0 → no-op; test 2 burned but test 3 never ran → net 1
 * → releases exactly 1; test 3 already released it → net 0 → no-op even if
 * afterAll itself is invoked more than once.
 */

test.describe.configure({ mode: "serial" });

test.use({ storageState: CONTRIBUTOR_B.storageState });

// Any distinct past bucket works — the lifetime sum is period-agnostic and a
// past month can never collide with the current period's lazy grant.
function pastPeriod() {
  const now = new Date();
  const monthStartUtc = (offset: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString();
  return { period_start: monthStartUtc(-1), period_end: monthStartUtc(0) };
}

test.describe("Free plan lifetime Optimization Run", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");

  let db: SupabaseClient;
  let teamBOrgId: string;

  test.beforeAll(() => {
    db = makeAdminClient()!;
    teamBOrgId = readSeed().teamBOrgId;
  });

  // The same net optimization_lifetime_used() the app reads: sum(reserve) -
  // sum(release) across every period for this org. Any outstanding burn —
  // whether test 2's insert or a stale leftover from a prior aborted run —
  // shows up here regardless of which synthetic period it landed in.
  async function lifetimeUsed(): Promise<number> {
    const { data, error } = await db.rpc("optimization_lifetime_used", {
      p_org_id: teamBOrgId,
    });
    if (error) throw new Error(`lifetime read failed: ${error.message}`);
    return Number(data ?? 0);
  }

  // Idempotent by construction: releases exactly what's outstanding, so
  // calling it when nothing was burned (test 2 never ran) or after the
  // burn was already released (test 3 ran, or a prior afterAll already
  // fired) is a safe no-op — it never inserts a release for units that
  // were never reserved.
  async function restoreLifetimeUnit(): Promise<void> {
    const used = await lifetimeUsed();
    if (used > 0) {
      const { error } = await db.from("optimization_run_ledger").insert({
        org_id: teamBOrgId,
        entry_type: "release",
        units: used,
        ...pastPeriod(),
        // meta.lifetime is what optimization_lifetime_used counts (#501,
        // CR-3). Without it this release would not net the burn back out,
        // `used` would stay positive forever, and every afterAll would insert
        // another dead release row.
        meta: { lifetime: true, e2e: "free-lifetime-optimization-spec afterAll restore" },
      });
      if (error) throw new Error(`lifetime afterAll restore failed: ${error.message}`);
    }
  }

  test.afterAll(async () => {
    if (!db || !teamBOrgId) return;
    await restoreLifetimeUnit();
  });

  test("a fresh Free Team sees its one run available and a live entry point", async ({
    page,
  }) => {
    await page.goto("/optimizations");
    await expect(page.getByText("1 available")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ New run" })).toBeVisible();
    await expect(page.getByTestId("optimization-gate")).toHaveCount(0);
  });

  test("consuming the lifetime unit gates the page with the used copy", async ({
    page,
  }) => {
    const { error } = await db.from("optimization_run_ledger").insert([
      { org_id: teamBOrgId, entry_type: "grant", units: 1, meta: {}, ...pastPeriod() },
      // meta.lifetime marks this as consuming the lifetime grant, which is
      // what optimization_lifetime_used sums (#501, CR-3). An untagged
      // reserve is paid per-period usage and would not gate the page.
      {
        org_id: teamBOrgId,
        entry_type: "reserve",
        units: 1,
        meta: { lifetime: true },
        ...pastPeriod(),
      },
    ]);
    if (error) throw new Error(`lifetime burn failed: ${error.message}`);

    await page.goto("/optimizations");
    await expect(page.getByText("0 available")).toBeVisible();
    const gate = page.getByTestId("optimization-gate");
    await expect(gate).toContainText("Upgrade to optimize");
    // The lifetime copy — used, not "not included": the unit never resets.
    await expect(gate).toHaveAttribute("title", /has been used/);
    await expect(page.getByRole("button", { name: "+ New run" })).toHaveCount(0);
  });

  test("a released unit restores the lifetime run (nothing was consumed)", async ({
    page,
  }) => {
    // What settle_optimization_run writes for a run with zero executed
    // Rollouts: the unit goes back, so the Team keeps its one lifetime run.
    const { error } = await db.from("optimization_run_ledger").insert([
      {
        org_id: teamBOrgId,
        entry_type: "release",
        units: 1,
        // settle copies the reserve's lifetime flag onto the release, so the
        // fixture mirrors it (#501, CR-3).
        meta: { lifetime: true },
        ...pastPeriod(),
      },
    ]);
    if (error) throw new Error(`lifetime release failed: ${error.message}`);

    await page.goto("/optimizations");
    await expect(page.getByText("1 available")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ New run" })).toBeVisible();
  });
});
