import { test, expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONTRIBUTOR_C,
  TEAM_C_CONNECTION_NAME,
  TEAM_C_RUBRIC_NAME,
  makeAdminClient,
  readSeed,
} from "./constants";

/**
 * Optimization Run allowance (#181) against Team C, the seeded Builder team
 * (Team B's subscription state belongs to the billing webhook specs). Burn the
 * allowance through the same atomic reserve RPC the app uses, then verify the
 * ceiling, the blocked submit (with the throttled Contributor email), and the
 * exhausted entry-point state. Serial: each test builds on the previous burn
 * level. Cleanup is a compensating release — the ledger is append-only.
 */

const MAILPIT_API = "http://127.0.0.1:54324";
const INCLUDED = 15; // Builder's includedOptimizationRuns
const CEILING = 200; // Builder's maxBudgetRollouts

test.describe.configure({ mode: "serial" });

test.describe("Optimization Run allowance", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");

  let db: SupabaseClient;
  let teamCOrgId: string;
  let periodStart: string;
  let periodEnd: string;

  async function balance(): Promise<number> {
    const { data, error } = await db.rpc("optimization_run_balance", {
      p_org_id: teamCOrgId,
      p_period_start: periodStart,
    });
    if (error) throw new Error(error.message);
    return Number(data);
  }

  async function burnTo(target: number): Promise<void> {
    while ((await balance()) > target) {
      const { error } = await db.rpc("reserve_optimization_run", {
        p_org_id: teamCOrgId,
        p_run_id: null,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_included: INCLUDED,
      });
      if (error) throw new Error(error.message);
    }
  }

  // Other Team C specs (wizard, a11y dialogs) run in parallel workers and need
  // the "+ New run" entry point live — restore the full allowance after EVERY
  // test so the burn window is as small as each test body, not the whole file.
  async function restoreAllowance(): Promise<void> {
    const refund = INCLUDED - (await balance());
    if (refund > 0) {
      const { error } = await db.from("optimization_run_ledger").insert({
        org_id: teamCOrgId,
        entry_type: "release",
        units: refund,
        period_start: periodStart,
        period_end: periodEnd,
        meta: { e2e: "allowance-spec restore" },
      });
      if (error) throw new Error(`allowance e2e restore failed: ${error.message}`);
    }
  }

  test.afterEach(async () => {
    if (db && periodStart) await restoreAllowance();
  });

  test.beforeAll(async () => {
    db = makeAdminClient()!;
    ({ teamCOrgId } = readSeed());

    // Team C's period is the seeded Stripe mirror period — read it from the
    // customers row so the test's entries land where the app reads.
    const { data: customer } = await db
      .from("customers")
      .select("current_period_start, current_period_end")
      .eq("org_id", teamCOrgId)
      .single();
    periodStart = new Date(customer!.current_period_start).toISOString();
    periodEnd = new Date(customer!.current_period_end).toISOString();

    const { error } = await db.rpc("ensure_optimization_grant", {
      p_org_id: teamCOrgId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_included: INCLUDED,
    });
    expect(error).toBeNull();
  });

  test.afterAll(async () => {
    if (!db || !periodStart) return;
    await restoreAllowance();
    // Free the email throttle claim so reruns send (and assert) a fresh email.
    await db
      .from("billing_notifications")
      .delete()
      .eq("org_id", teamCOrgId)
      .eq("kind", "optimization_runs_limit");
  });

  test("the wizard caps the rollout budget at the plan ceiling", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: CONTRIBUTOR_C.storageState });
    const page = await ctx.newPage();
    await page.goto("/optimizations");
    await page.getByRole("button", { name: "+ New run" }).click();
    const dialog = page.getByRole("dialog");

    // Walk to Tuning: Basics (seeded rubric) → System → Instances. System defaults to the managed
    // "Paste a prompt" mode (#293); switch to the seeded existing Connection to advance.
    await dialog.getByLabel("Rubric").selectOption({ label: TEAM_C_RUBRIC_NAME });
    await dialog.getByRole("button", { name: "Next" }).click();
    await dialog.getByRole("radio", { name: /Use an existing System/ }).check();
    await dialog.getByRole("button", { name: "Next" }).click();
    await dialog.getByPlaceholder(/User input/).fill("Route this ticket");
    await dialog.getByRole("button", { name: "Next" }).click();

    const budget = dialog.getByLabel("Rollout budget");
    await expect(budget).toHaveAttribute("max", String(CEILING));
    await budget.fill(String(CEILING + 1));
    await dialog.getByRole("button", { name: "Next" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      `Rollout budget can't exceed ${CEILING} on your plan.`
    );
    await ctx.close();
  });

  test("a submit racing the last unit is refused with the exact message and emails Contributors", async ({
    browser,
  }) => {
    // The entry point was live when the page loaded (1 remaining)…
    const ctx = await browser.newContext({ storageState: CONTRIBUTOR_C.storageState });
    const page = await ctx.newPage();
    await page.goto("/optimizations");
    await page.getByRole("button", { name: "+ New run" }).click();
    const dialog = page.getByRole("dialog");

    await dialog.getByLabel("Rubric").selectOption({ label: TEAM_C_RUBRIC_NAME });
    await dialog.getByRole("button", { name: "Next" }).click();
    await dialog.getByRole("button", { name: "Next" }).click();
    await dialog.getByPlaceholder(/User input/).fill("Route this ticket");
    await dialog.getByRole("button", { name: "Next" }).click();
    await dialog.getByRole("button", { name: "Next" }).click();

    // …but the allowance runs dry before they click Start (#181's race).
    await burnTo(0);
    await dialog.getByRole("button", { name: "Start run" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      `used all ${INCLUDED} Optimization Runs`
    );
    await expect(dialog.getByText(TEAM_C_CONNECTION_NAME)).toBeVisible(); // still on Review
    await ctx.close();

    // The throttled limit email reached the Team's Contributor.
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
              m.Subject.includes("has used its Optimization Runs") &&
              m.To.some((t) => t.Address === CONTRIBUTOR_C.email)
          );
        },
        { timeout: 15_000 }
      )
      .toBe(true);
  });

  test("an exhausted allowance disables the entry point with an explanation", async ({
    browser,
  }) => {
    await burnTo(0);
    const ctx = await browser.newContext({ storageState: CONTRIBUTOR_C.storageState });
    const page = await ctx.newPage();
    await page.goto("/optimizations");
    await expect(page.getByTestId("optimization-exhausted")).toBeVisible();
    await expect(
      page.getByText(`All ${INCLUDED} included Optimization Runs are used this period`, {
        exact: false,
      })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "+ New run" })).toHaveCount(0);
    await ctx.close();
  });
});
