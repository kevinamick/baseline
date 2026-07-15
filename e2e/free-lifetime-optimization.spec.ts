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
      { org_id: teamBOrgId, entry_type: "grant", units: 1, ...pastPeriod() },
      { org_id: teamBOrgId, entry_type: "reserve", units: 1, ...pastPeriod() },
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
      { org_id: teamBOrgId, entry_type: "release", units: 1, ...pastPeriod() },
    ]);
    if (error) throw new Error(`lifetime release failed: ${error.message}`);

    await page.goto("/optimizations");
    await expect(page.getByText("1 available")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ New run" })).toBeVisible();
  });
});
