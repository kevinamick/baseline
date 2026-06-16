import { describe, it, expect, beforeAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

// The Stripe client wrapper is stubbed so syncManagedInvoiceLines can be driven
// against the real DB without a Stripe account; the static `Stripe.Decimal` (from
// the real package) is untouched. Hoisted so the spies exist before the mock.
const stripeMocks = vi.hoisted(() => ({
  invoicesCreate: vi.fn(async () => ({ id: "in_test_1" })),
  finalizeInvoice: vi.fn(async () => ({ id: "in_test_1", status: "open" })),
  invoiceRetrieve: vi.fn(async () => ({ id: "in_test_1", status: "open" })),
  invoiceItemsCreate: vi.fn(async (args: { description?: string; invoice?: string }) => ({
    id: `ii_${args.description ?? "x"}`,
  })),
}));
vi.mock("@/lib/stripe", () => ({
  stripe: {
    invoices: {
      create: stripeMocks.invoicesCreate,
      finalizeInvoice: stripeMocks.finalizeInvoice,
      retrieve: stripeMocks.invoiceRetrieve,
    },
    invoiceItems: { create: stripeMocks.invoiceItemsCreate },
  },
}));

// The server modules are imported DYNAMICALLY inside the tests (not at top
// level): they pull in @/lib/supabase/admin, which throws at import without the
// local Supabase env. Static imports would crash the file even when skipped;
// dynamic imports run only when the DB-gated tests actually execute.

/**
 * Integration tests for token invoice lines & threshold billing (#186). The
 * accrue→mirror maintenance, watermark, reconciliation, threshold sweep, and the
 * fail-closed state machine live in Postgres + the server seam, so they're
 * verified against the real local DB. Skipped without local Supabase env:
 *
 *   set -a; source .env.local; set +a; npx vitest run managed-threshold-billing.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

const PERIOD_START = "2026-08-01T00:00:00.000Z";
const PERIOD_END = "2026-09-01T00:00:00.000Z";
const MARKUP_PCT = 40;

describe.skipIf(!hasDb)("managed threshold billing (integration)", () => {
  let db: SupabaseClient;
  let orgId: string;
  let userId: string;
  let rubricId: string;

  async function newMeteredRun(period = PERIOD_START): Promise<string> {
    const { data, error } = await db
      .from("eval_runs")
      .insert({ created_by: userId, rubric_id: rubricId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const runId = data.id as string;
    const { error: rErr } = await db.rpc("reserve_eval_points", {
      p_org_id: orgId,
      p_run_id: runId,
      p_cost: 1,
      p_period_start: period,
      p_period_end: PERIOD_END,
      p_included: 1_000_000,
      p_meta: {},
    });
    if (rErr) throw new Error(rErr.message);
    return runId;
  }

  async function accrue(runId: string, amount: number, model: string): Promise<void> {
    const { error } = await db.rpc("accrue_managed_spend", {
      p_org_id: orgId,
      p_amount_usd: amount,
      p_provider: "anthropic",
      p_model: model,
      p_input_tokens: 1000,
      p_output_tokens: 200,
      p_input_unit_usd: 0.000001,
      p_output_unit_usd: 0.000005,
      p_markup_pct: MARKUP_PCT,
      p_call_kind: "judge",
      p_eval_run_id: runId,
      p_opt_run_id: null,
    });
    if (error) throw new Error(error.message);
  }

  async function ledgerAccrued(period = PERIOD_START): Promise<number> {
    const { data } = await db.rpc("managed_spend_total", {
      p_org_id: orgId,
      p_period_start: period,
    });
    return Number(data ?? 0);
  }

  async function uninvoiced(period = PERIOD_START): Promise<number> {
    const { data } = await db.rpc("managed_uninvoiced_total", {
      p_org_id: orgId,
      p_period_start: period,
    });
    return Number(data ?? 0);
  }

  async function lines(period = PERIOD_START) {
    const { data } = await db
      .from("managed_invoice_lines")
      .select("provider, model, accrued_usd, invoiced_usd, dirty")
      .eq("org_id", orgId)
      .eq("period_start", period);
    return data ?? [];
  }

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });

    const { data: org, error: orgError } = await db
      .from("organizations")
      .insert({ name: "Managed Threshold Integration Org" })
      .select("id")
      .single();
    if (orgError) throw new Error(orgError.message);
    orgId = org.id;

    const { data: authUser, error: authError } = await db.auth.admin.createUser({
      email: `managed-threshold-${crypto.randomUUID()}@example.com`,
      password: crypto.randomUUID(),
      email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    userId = authUser.user.id;
    await db.from("users").upsert({ id: userId }, { onConflict: "id" });

    const { data: rubric, error: rubricError } = await db
      .from("rubrics")
      .insert({
        org_id: orgId,
        created_by: userId,
        name: "Managed threshold rubric",
        scenario_description: "integration",
        expected_outcome: "integration",
        evaluation_mode: "prompt_response",
        criteria: [{ name: "c1", weight: 1, steps: ["s"] }],
      })
      .select("id")
      .single();
    if (rubricError) throw new Error(rubricError.message);
    rubricId = rubric.id;
  });

  it("accrual maintains the invoice mirror incrementally (one dirty line per provider/model)", async () => {
    const run = await newMeteredRun();
    await accrue(run, 1.5, "claude-haiku-4-5-20251001");
    await accrue(run, 0.5, "claude-haiku-4-5-20251001"); // same line → adds up
    await accrue(run, 2.0, "claude-opus-4-8"); // distinct line

    const ls = await lines();
    const haiku = ls.find((l) => l.model === "claude-haiku-4-5-20251001");
    const opus = ls.find((l) => l.model === "claude-opus-4-8");
    expect(Number(haiku?.accrued_usd)).toBeCloseTo(2.0, 6);
    expect(Number(opus?.accrued_usd)).toBeCloseTo(2.0, 6);
    expect(haiku?.dirty).toBe(true);
    // The mirror's accrued sum equals the ledger's accrued total.
    const mirrorSum = ls.reduce((s, l) => s + Number(l.accrued_usd), 0);
    expect(mirrorSum).toBeCloseTo(await ledgerAccrued(), 6);
  });

  it("refresh recomputes the mirror from the immutable ledger", async () => {
    // Corrupt a line, then prove refresh restores it to the ledger truth.
    await db
      .from("managed_invoice_lines")
      .update({ accrued_usd: 999 })
      .eq("org_id", orgId)
      .eq("model", "claude-opus-4-8");
    const { error } = await db.rpc("refresh_managed_invoice_lines", {
      p_org_id: orgId,
      p_period_start: PERIOD_START,
    });
    expect(error).toBeNull();
    const opus = (await lines()).find((l) => l.model === "claude-opus-4-8");
    expect(Number(opus?.accrued_usd)).toBeCloseTo(2.0, 6);
  });

  it("un-invoiced total = accrued − invoiced, and reconciles to zero once fully invoiced", async () => {
    const accrued = await ledgerAccrued();
    expect(await uninvoiced()).toBeCloseTo(accrued, 6);

    // Simulate finalized invoices: mark each line's full outstanding amount.
    for (const l of await lines()) {
      const amount = Number(l.accrued_usd) - Number(l.invoiced_usd);
      const { error } = await db.rpc("mark_managed_line_invoiced", {
        p_org_id: orgId,
        p_period_start: PERIOD_START,
        p_provider: l.provider,
        p_model: l.model,
        p_amount: amount,
        p_invoice_id: "in_recon",
        p_item_id: "ii_recon",
      });
      expect(error).toBeNull();
    }

    // Reconciliation: invoiced spend exactly equals accrued spend for the window.
    const invoicedSum = (await lines()).reduce((s, l) => s + Number(l.invoiced_usd), 0);
    expect(invoicedSum).toBeCloseTo(accrued, 6);
    expect(await uninvoiced()).toBeCloseTo(0, 6);
    // Fully invoiced → no longer dirty.
    expect((await lines()).every((l) => l.dirty === false)).toBe(true);
  });

  it("a new accrue after invoicing re-arms the line across the boundary", async () => {
    const run = await newMeteredRun();
    await accrue(run, 0.75, "claude-haiku-4-5-20251001");
    const haiku = (await lines()).find((l) => l.model === "claude-haiku-4-5-20251001");
    // accrued grew past the already-invoiced watermark → dirty again, owed again.
    expect(Number(haiku?.accrued_usd) - Number(haiku?.invoiced_usd)).toBeCloseTo(0.75, 6);
    expect(haiku?.dirty).toBe(true);
    expect(await uninvoiced()).toBeCloseTo(0.75, 6);
  });

  it("tick_managed_threshold counts orgs carrying un-invoiced spend", async () => {
    const { data, error } = await db.rpc("tick_managed_threshold");
    expect(error).toBeNull();
    expect(Number(data)).toBeGreaterThanOrEqual(1);
  });

  it("syncManagedInvoiceLines issues one charge-now invoice, itemized, and advances the watermark", async () => {
    // A fresh org/period whose period has ENDED, so billing fires regardless of
    // plan/threshold env. A Stripe customer is required to push.
    const { data: org } = await db
      .from("organizations")
      .insert({ name: "Managed sync org" })
      .select("id")
      .single();
    const syncOrg = org!.id as string;
    await db.from("customers").insert({
      org_id: syncOrg,
      stripe_customer_id: "cus_sync_test",
      status: "active",
      stripe_price_id: "price_unmapped",
    });
    const PAST_END = "2020-02-01T00:00:00.000Z";
    await db.from("managed_invoice_lines").insert([
      {
        org_id: syncOrg,
        period_start: "2020-01-01T00:00:00.000Z",
        period_end: PAST_END,
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        accrued_usd: 3,
        invoiced_usd: 0,
        dirty: true,
      },
      {
        org_id: syncOrg,
        period_start: "2020-01-01T00:00:00.000Z",
        period_end: PAST_END,
        provider: "anthropic",
        model: "claude-opus-4-8",
        accrued_usd: 2,
        invoiced_usd: 0,
        dirty: true,
      },
    ]);

    stripeMocks.invoicesCreate.mockClear();
    stripeMocks.invoiceItemsCreate.mockClear();
    stripeMocks.finalizeInvoice.mockClear();

    const { syncManagedInvoiceLines } = await import("@/lib/billing/managed-invoice-sync");
    await syncManagedInvoiceLines(syncOrg);

    // One dedicated, charge-now invoice tagged so the webhook can identify it,
    // and NOT sweeping unrelated pending overage items.
    expect(stripeMocks.invoicesCreate).toHaveBeenCalledTimes(1);
    const invArgs = (stripeMocks.invoicesCreate.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(invArgs.collection_method).toBe("charge_automatically");
    expect(invArgs.pending_invoice_items_behavior).toBe("exclude");
    expect((invArgs.metadata as Record<string, string>).kind).toBe("managed_tokens");
    // One line item per (provider, model), each attached to this invoice.
    expect(stripeMocks.invoiceItemsCreate).toHaveBeenCalledTimes(2);
    for (const call of stripeMocks.invoiceItemsCreate.mock.calls) {
      expect((call[0] as { invoice?: string }).invoice).toBe("in_test_1");
    }
    expect(stripeMocks.finalizeInvoice).toHaveBeenCalledWith("in_test_1", { auto_advance: true });

    // Watermark advanced on confirmed finalize; nothing left owing.
    const { data: after } = await db
      .from("managed_invoice_lines")
      .select("accrued_usd, invoiced_usd, dirty, stripe_invoice_id")
      .eq("org_id", syncOrg);
    for (const l of after ?? []) {
      expect(Number(l.invoiced_usd)).toBeCloseTo(Number(l.accrued_usd), 6);
      expect(l.dirty).toBe(false);
      expect(l.stripe_invoice_id).toBe("in_test_1");
    }

    await db.from("organizations").delete().eq("id", syncOrg);
  });

  it("does not stack a second invoice while a managed payment is already failing (B2)", async () => {
    const { syncManagedInvoiceLines } = await import("@/lib/billing/managed-invoice-sync");
    const { data: org } = await db
      .from("organizations")
      .insert({ name: "Managed blocked org" })
      .select("id")
      .single();
    const blockedOrg = org!.id as string;
    await db.from("customers").insert({
      org_id: blockedOrg,
      stripe_customer_id: "cus_blocked",
      status: "active",
      stripe_price_id: "price_unmapped",
      managed_payment_failed_at: new Date().toISOString(),
      managed_failed_invoice_id: "in_prev",
    });
    await db.from("managed_invoice_lines").insert({
      org_id: blockedOrg,
      period_start: "2020-01-01T00:00:00.000Z",
      period_end: "2020-02-01T00:00:00.000Z",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      accrued_usd: 5,
      invoiced_usd: 0,
      dirty: true,
    });
    stripeMocks.invoicesCreate.mockClear();

    await syncManagedInvoiceLines(blockedOrg);
    // Already fail-closed → no new invoice piled on the unpaid one.
    expect(stripeMocks.invoicesCreate).not.toHaveBeenCalled();

    await db.from("organizations").delete().eq("id", blockedOrg);
  });

  it("advances the watermark on crash-resume when the invoice was already finalized (B1)", async () => {
    const { syncManagedInvoiceLines } = await import("@/lib/billing/managed-invoice-sync");
    const { data: org } = await db
      .from("organizations")
      .insert({ name: "Managed resume org" })
      .select("id")
      .single();
    const resumeOrg = org!.id as string;
    await db.from("customers").insert({
      org_id: resumeOrg,
      stripe_customer_id: "cus_resume",
      status: "active",
      stripe_price_id: "price_unmapped",
    });
    await db.from("managed_invoice_lines").insert({
      org_id: resumeOrg,
      period_start: "2020-01-01T00:00:00.000Z",
      period_end: "2020-02-01T00:00:00.000Z",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      accrued_usd: 4,
      invoiced_usd: 0,
      dirty: true,
    });
    // Simulate crash-resume: the create idempotency key reconstructed the same
    // invoice, already finalized on a prior run → finalize rejects, retrieve
    // shows it's no longer a draft → the watermark must still advance.
    stripeMocks.finalizeInvoice.mockRejectedValueOnce(new Error("Invoice is already finalized"));
    stripeMocks.invoiceRetrieve.mockResolvedValueOnce({ id: "in_test_1", status: "open" });

    await syncManagedInvoiceLines(resumeOrg);

    const { data: after } = await db
      .from("managed_invoice_lines")
      .select("accrued_usd, invoiced_usd, dirty")
      .eq("org_id", resumeOrg)
      .single();
    expect(Number(after!.invoiced_usd)).toBeCloseTo(Number(after!.accrued_usd), 6);
    expect(after!.dirty).toBe(false);

    await db.from("organizations").delete().eq("id", resumeOrg);
  });

  it("fail-closed state machine: a declined managed invoice blocks managed runs, not BYO, and clears on pay", async () => {
    const { isManagedPaymentBlocked } = await import("@/lib/billing/managed-spend");
    const { managedRunBlockedForPayment } = await import("@/lib/llm/key-gate");
    process.env.STRIPE_PRICE_BUILDER = "price_builder_test";
    const { data: org } = await db
      .from("organizations")
      .insert({ name: "Managed fail-closed org" })
      .select("id")
      .single();
    const fcOrg = org!.id as string;
    // Builder, active → managed mode (no BYO key).
    await db.from("customers").insert({
      org_id: fcOrg,
      stripe_customer_id: "cus_fc_test",
      status: "active",
      stripe_price_id: "price_builder_test",
    });

    // Healthy: managed run not blocked.
    expect(await isManagedPaymentBlocked(fcOrg)).toBe(false);
    expect(await managedRunBlockedForPayment(fcOrg)).toBe(false);

    // Declined managed invoice (what the webhook writes).
    await db
      .from("customers")
      .update({ managed_payment_failed_at: new Date().toISOString(), managed_failed_invoice_id: "in_fc" })
      .eq("org_id", fcOrg);

    expect(await isManagedPaymentBlocked(fcOrg)).toBe(true);
    expect(await managedRunBlockedForPayment(fcOrg)).toBe(true);

    // BYO key for the provider → that run is byo, never blocked by managed state.
    await db.rpc("set_provider_key", {
      p_org_id: fcOrg,
      p_provider: "anthropic",
      p_secret: "sk-ant-fc-test",
      p_last4: "test",
      p_created_by: userId,
    });
    expect(await managedRunBlockedForPayment(fcOrg)).toBe(false);

    // Recovery: invoice paid → webhook clears the flag → managed runs resume.
    await db
      .from("customers")
      .update({ managed_payment_failed_at: null, managed_failed_invoice_id: null })
      .eq("org_id", fcOrg);
    await db.from("provider_keys").delete().eq("org_id", fcOrg);
    expect(await isManagedPaymentBlocked(fcOrg)).toBe(false);
    expect(await managedRunBlockedForPayment(fcOrg)).toBe(false);

    await db.from("organizations").delete().eq("id", fcOrg);
  });
});
