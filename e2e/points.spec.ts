import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONTRIBUTOR_A,
  READONLY_A,
  RUBRIC_SUPPORT,
  makeAdminClient,
  readSeed,
} from "./constants";
import { anniversaryPeriod } from "../src/lib/billing/period";
import { evalRunPointsPerRow } from "../src/lib/billing/points";
import { PLANS } from "../src/lib/billing/plans";

/**
 * Eval Point hard stop (#180): burn Team A's Free allotment down to a few
 * points (via the same atomic reserve RPC the app uses), then verify the next
 * run is blocked in the dialog with exact numbers, Contributors get the limit
 * email (Mailpit), and /settings/billing renders the balance + ledger.
 *
 * The ledger is append-only — cleanup is a compensating `release` entry, not a
 * delete, and the burn-down tops up to a fixed remainder, so repeat local runs
 * are self-healing. Serial mode: later tests depend on the refusal happening.
 */

const MAILPIT_API = "http://127.0.0.1:54324";
const INCLUDED = PLANS.free.includedEvalPoints;
/** What the burn-down leaves: below any single row's cost (min is 10 + 5×1). */
const LEAVE = 5;

test.describe.configure({ mode: "serial" });

test.describe("Eval Point hard stop", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");

  let db: SupabaseClient;
  let teamAOrgId: string;
  let periodStart: string;
  let periodEnd: string;
  let perRowCost: number;

  test.beforeAll(async () => {
    db = makeAdminClient()!;
    ({ teamAOrgId } = readSeed());

    // Team A is Free: its period anchors to the Team-creation anniversary —
    // computed with the same pure helper the app uses, so the test's entries
    // land in the same period the app reads.
    const { data: org } = await db
      .from("organizations")
      .select("created_at")
      .eq("id", teamAOrgId)
      .single();
    const period = anniversaryPeriod(new Date(org!.created_at), new Date());
    periodStart = period.start.toISOString();
    periodEnd = period.end.toISOString();

    const { data: rubric } = await db
      .from("rubrics")
      .select("criteria")
      .eq("org_id", teamAOrgId)
      .eq("name", RUBRIC_SUPPORT)
      .single();
    perRowCost = evalRunPointsPerRow((rubric!.criteria as unknown[]).length);

    const { error: grantError } = await db.rpc("ensure_point_grant", {
      p_org_id: teamAOrgId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_included: INCLUDED,
    });
    expect(grantError).toBeNull();

    const { data: balance } = await db.rpc("point_balance", {
      p_org_id: teamAOrgId,
      p_period_start: periodStart,
    });
    const topUp = Number(balance) - LEAVE;
    if (topUp > 0) {
      const { error } = await db.rpc("reserve_eval_points", {
        p_org_id: teamAOrgId,
        p_run_id: null,
        p_cost: topUp,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_included: INCLUDED,
        p_meta: { e2e: "points-spec burn-down" },
      });
      expect(error).toBeNull();
    }
  });

  test.afterAll(async () => {
    if (!db || !periodStart) return;
    // Compensating release: restores the full allotment for every other spec
    // and the next run of this one, without violating append-only.
    const { data: balance } = await db.rpc("point_balance", {
      p_org_id: teamAOrgId,
      p_period_start: periodStart,
    });
    const refund = INCLUDED - Number(balance ?? INCLUDED);
    if (refund > 0) {
      const { error } = await db.from("point_ledger").insert({
        org_id: teamAOrgId,
        entry_type: "release",
        points: refund,
        period_start: periodStart,
        period_end: periodEnd,
        meta: { e2e: "points-spec restore" },
      });
      if (error) throw new Error(`points e2e cleanup failed: ${error.message}`);
    }
  });

  test("a run over the remaining balance is blocked with exact numbers", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ storageState: CONTRIBUTOR_A.storageState });
    const page = await ctx.newPage();
    await page.goto("/rubrics");
    await page.getByRole("button", { name: RUBRIC_SUPPORT }).click();
    await page.getByRole("button", { name: "Run eval" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.locator("#user-input-0").fill("What is 2+2?");
    await dialog.locator("#agent-output-0").fill("4");

    // The exact cost shows before the run starts (transparency rule).
    await expect(dialog.getByTestId("run-point-cost")).toContainText(
      perRowCost.toLocaleString("en-US")
    );

    await dialog.getByRole("button", { name: "Run eval" }).click();

    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText("Not enough Eval Points");
    await expect(alert).toContainText(perRowCost.toLocaleString("en-US"));
    await expect(alert).toContainText(String(LEAVE));
    await expect(alert.getByRole("link", { name: /View usage/ })).toBeVisible();
    await ctx.close();
  });

  test("Contributors receive the limit email", async () => {
    await expect
      .poll(
        async () => {
          const res = await fetch(`${MAILPIT_API}/api/v1/messages?limit=50`);
          if (!res.ok) return false;
          const body = (await res.json()) as {
            messages?: { Subject: string; To: { Address: string }[] }[];
          };
          return (body.messages ?? []).some(
            (m) =>
              m.Subject.includes("has hit its Eval Point limit") &&
              m.To.some((t) => t.Address === CONTRIBUTOR_A.email)
          );
        },
        { timeout: 15_000 }
      )
      .toBe(true);
  });

  test("the billing page shows the balance and the period's ledger", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ storageState: CONTRIBUTOR_A.storageState });
    const page = await ctx.newPage();
    await page.goto("/settings/billing");

    await expect(page.getByTestId("point-balance")).toHaveText(
      new RegExp(`^${LEAVE}\\s*of ${INCLUDED.toLocaleString("en-US")} remaining$`)
    );
    // 5 points is below the cheapest possible run, so the page must say so.
    await expect(page.getByTestId("points-exhausted")).toBeVisible();
    const ledger = page.getByTestId("point-ledger");
    await expect(ledger.getByText("Period grant").first()).toBeVisible();
    await expect(ledger.getByText("Reserved for eval run").first()).toBeVisible();
    await ctx.close();
  });

  test("Readonly Members are redirected away from the billing page", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ storageState: READONLY_A.storageState });
    const page = await ctx.newPage();
    await page.goto("/settings/billing");
    await expect(page).toHaveURL(/\/rubrics/);
    await ctx.close();
  });
});
