import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockDirtySelect,
  mockCustomerSelect,
  mockLineUpdate,
  mockItemCreate,
  mockItemUpdate,
  mockItemRetrieve,
  mockGetBillingState,
} = vi.hoisted(() => ({
  mockDirtySelect: vi.fn(),
  mockCustomerSelect: vi.fn(),
  mockLineUpdate: vi.fn(),
  mockItemCreate: vi.fn(),
  mockItemUpdate: vi.fn(),
  mockItemRetrieve: vi.fn(),
  mockGetBillingState: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "overage_invoice_lines") {
        return {
          // .select(...).eq("org_id").eq("dirty", true)
          select: () => ({ eq: () => ({ eq: mockDirtySelect }) }),
          // .update({...}).eq×3 or ×4 — record the patch when awaited
          update: (patch: unknown) => {
            const chain = {
              eq: () => chain,
              then: (resolve: (v: unknown) => void) => {
                mockLineUpdate(patch);
                resolve({ error: null });
              },
            };
            return chain;
          },
        };
      }
      // customers
      return {
        select: () => ({ eq: () => ({ maybeSingle: mockCustomerSelect }) }),
      };
    },
  },
}));
vi.mock("@/lib/stripe", () => ({
  stripe: {
    invoiceItems: {
      create: mockItemCreate,
      update: mockItemUpdate,
      retrieve: mockItemRetrieve,
    },
  },
}));
vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));
vi.mock("@/lib/logging/server", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { syncOverageInvoiceItems } from "../overage-sync";
import { PLANS } from "../plans";

const PERIOD = "2026-06-01T00:00:00.000Z";

function line(overrides: Record<string, unknown> = {}) {
  return {
    period_start: PERIOD,
    meter: "points",
    quantity: 2_000,
    unit_usd: null,
    stripe_invoice_item_id: null,
    invoiced_quantity: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_PRICE_BUILDER = "price_builder_live";
  process.env.STRIPE_PRICE_SCALE = "price_scale_live";
  mockGetBillingState.mockResolvedValue({
    active: true,
    plan: "builder",
    priceId: "price_builder_live",
  });
  mockCustomerSelect.mockResolvedValue({
    data: { stripe_customer_id: "cus_1" },
    error: null,
  });
  mockItemCreate.mockResolvedValue({ id: "ii_new" });
  mockItemUpdate.mockResolvedValue({ id: "ii_old" });
});

describe("syncOverageInvoiceItems", () => {
  it("creates an idempotent invoice item and persists the id unconditionally", async () => {
    mockDirtySelect.mockResolvedValue({ data: [line()] });
    await syncOverageInvoiceItems("org_1");

    const [params, opts] = mockItemCreate.mock.calls[0];
    expect(params).toMatchObject({ customer: "cus_1", quantity: 2_000 });
    // Builder's $0.0005/point in decimal cents (Decimal normalizes zeros).
    expect(Number(String(params.unit_amount_decimal))).toBe(
      PLANS.builder.evalPointOverageUsd! * 100
    );
    // Racing creates collapse at Stripe via the line-identity key.
    expect(opts.idempotencyKey).toBe(`ovg1:org_1:${PERIOD}:points:0`);
    // First update persists id + rate snapshot, second clears dirty.
    expect(mockLineUpdate).toHaveBeenNthCalledWith(1, {
      stripe_invoice_item_id: "ii_new",
      unit_usd: PLANS.builder.evalPointOverageUsd,
    });
    expect(mockLineUpdate).toHaveBeenNthCalledWith(2, { dirty: false });
  });

  it("bills only the un-invoiced remainder and reuses the snapshotted rate", async () => {
    // Scale-priced snapshot survives a downgrade to Builder.
    mockDirtySelect.mockResolvedValue({
      data: [line({ quantity: 5_000, invoiced_quantity: 3_000, unit_usd: 0.0003 })],
    });
    await syncOverageInvoiceItems("org_1");
    const [params] = mockItemCreate.mock.calls[0];
    expect(params.quantity).toBe(2_000);
    expect(Number(String(params.unit_amount_decimal))).toBe(0.03);
  });

  it("updates the existing live item in place", async () => {
    // A legacy "runs" overage line (pre-ADR-0016) bills at its pinned unit_usd —
    // there is no live runs rate fallback anymore.
    mockDirtySelect.mockResolvedValue({
      data: [line({ meter: "runs", quantity: 3, unit_usd: 1.5, stripe_invoice_item_id: "ii_old" })],
    });
    await syncOverageInvoiceItems("org_1");
    expect(mockItemUpdate).toHaveBeenCalledWith("ii_old", { quantity: 3 });
    expect(mockItemCreate).not.toHaveBeenCalled();
  });

  it("rolls a finalized item into invoiced_quantity and leaves the line dirty", async () => {
    mockDirtySelect.mockResolvedValue({
      data: [line({ quantity: 2_500, stripe_invoice_item_id: "ii_old" })],
    });
    mockItemUpdate.mockRejectedValue(new Error("invoice is finalized"));
    mockItemRetrieve.mockResolvedValue({ id: "ii_old", invoice: "in_done", quantity: 2_000 });

    await syncOverageInvoiceItems("org_1");

    expect(mockLineUpdate).toHaveBeenCalledWith({
      invoiced_quantity: 2_000,
      stripe_invoice_item_id: null,
    });
    // No dirty:false write — the remainder (500) pushes on the next sync.
    expect(mockLineUpdate).not.toHaveBeenCalledWith({ dirty: false });
  });

  it("targets the draft invoice only for lines from closed periods", async () => {
    const newPeriod = new Date().toISOString();
    mockDirtySelect.mockResolvedValue({
      data: [line(), line({ period_start: newPeriod, quantity: 10 })],
    });
    await syncOverageInvoiceItems("org_1", {
      invoiceId: "in_draft",
      invoiceCreatedAt: Math.floor(Date.now() / 1000),
    });
    const calls = mockItemCreate.mock.calls.map(([p]) => p);
    const oldLine = calls.find((p) => p.quantity === 2_000)!;
    const newLine = calls.find((p) => p.quantity === 10)!;
    expect(oldLine.invoice).toBe("in_draft");
    expect(newLine.invoice).toBeUndefined();
  });

  it("skips entirely (warning, not throw) when no Stripe customer exists", async () => {
    mockDirtySelect.mockResolvedValue({ data: [line()] });
    mockCustomerSelect.mockResolvedValue({ data: null, error: null });
    await expect(syncOverageInvoiceItems("org_1")).resolves.toBeUndefined();
    expect(mockItemCreate).not.toHaveBeenCalled();
    expect(mockLineUpdate).not.toHaveBeenCalled();
  });

  it("a failed push leaves the line dirty for the next sync", async () => {
    mockDirtySelect.mockResolvedValue({ data: [line({ quantity: 10 })] });
    mockItemCreate.mockRejectedValue(new Error("stripe down"));
    await expect(syncOverageInvoiceItems("org_1")).resolves.toBeUndefined();
    expect(mockLineUpdate).not.toHaveBeenCalled();
  });

  it("is a no-op when there are no dirty rows at all (empty array)", async () => {
    mockDirtySelect.mockResolvedValue({ data: [] });
    await syncOverageInvoiceItems("org_1");
    expect(mockGetBillingState).not.toHaveBeenCalled();
  });

  it("is a no-op when data itself is null (no error)", async () => {
    mockDirtySelect.mockResolvedValue({ data: null });
    await syncOverageInvoiceItems("org_1");
    expect(mockGetBillingState).not.toHaveBeenCalled();
  });

  it("skips a 'points' line with an unrecognized priceId (no plan → no live rate) and no pinned rate", async () => {
    mockGetBillingState.mockResolvedValue({ active: true, plan: "free", priceId: "price_retired" });
    mockDirtySelect.mockResolvedValue({ data: [line({ unit_usd: null, stripe_invoice_item_id: null })] });
    await syncOverageInvoiceItems("org_1");
    expect(mockItemCreate).not.toHaveBeenCalled();
    expect(mockLineUpdate).not.toHaveBeenCalled();
  });

  it("re-throws (leaves dirty) a transient update failure where the item never finalized", async () => {
    mockDirtySelect.mockResolvedValue({
      data: [line({ stripe_invoice_item_id: "ii_old" })],
    });
    mockItemUpdate.mockRejectedValue(new Error("network blip"));
    mockItemRetrieve.mockResolvedValue({ id: "ii_old", invoice: null }); // never finalized
    await expect(syncOverageInvoiceItems("org_1")).resolves.toBeUndefined();
    expect(mockLineUpdate).not.toHaveBeenCalled();
  });

  it("falls through untouched (still clears dirty) when pendingTarget is exactly zero", async () => {
    mockDirtySelect.mockResolvedValue({
      data: [line({ quantity: 100, invoiced_quantity: 100, stripe_invoice_item_id: null })],
    });
    await syncOverageInvoiceItems("org_1");
    expect(mockItemCreate).not.toHaveBeenCalled();
    expect(mockItemUpdate).not.toHaveBeenCalled();
    expect(mockLineUpdate).toHaveBeenCalledWith({ dirty: false });
  });

  it("treats a missing finalized-item quantity as zero", async () => {
    mockDirtySelect.mockResolvedValue({
      data: [line({ quantity: 2_500, invoiced_quantity: 100, stripe_invoice_item_id: "ii_old" })],
    });
    mockItemUpdate.mockRejectedValue(new Error("invoice is finalized"));
    mockItemRetrieve.mockResolvedValue({ id: "ii_old", invoice: "in_done" }); // no quantity field
    await syncOverageInvoiceItems("org_1");
    expect(mockLineUpdate).toHaveBeenCalledWith({
      invoiced_quantity: 100,
      stripe_invoice_item_id: null,
    });
  });

  it("returns (never throws) when the dirty-lines fetch itself errors", async () => {
    mockDirtySelect.mockResolvedValue({ data: null, error: new Error("db down") });
    await expect(syncOverageInvoiceItems("org_1")).resolves.toBeUndefined();
    expect(mockItemCreate).not.toHaveBeenCalled();
  });

  it("returns (never throws) when the customer lookup itself errors", async () => {
    mockDirtySelect.mockResolvedValue({ data: [line()] });
    mockCustomerSelect.mockResolvedValue({ data: null, error: new Error("db down") });
    await expect(syncOverageInvoiceItems("org_1")).resolves.toBeUndefined();
    expect(mockItemCreate).not.toHaveBeenCalled();
  });

  it("never throws — an unexpected error anywhere is caught at the top level", async () => {
    mockDirtySelect.mockResolvedValue({ data: [line()] });
    mockGetBillingState.mockRejectedValue(new Error("boom"));
    await expect(syncOverageInvoiceItems("org_1")).resolves.toBeUndefined();
  });

  it("skips a legacy 'runs' line with no pinned rate and no live fallback", async () => {
    mockDirtySelect.mockResolvedValue({
      data: [line({ meter: "runs", unit_usd: null, stripe_invoice_item_id: null })],
    });
    await syncOverageInvoiceItems("org_1");
    expect(mockItemCreate).not.toHaveBeenCalled();
    expect(mockItemUpdate).not.toHaveBeenCalled();
    // No unit rate → the line stays dirty; the unconditional "clear dirty" step
    // never runs for this line.
    expect(mockLineUpdate).not.toHaveBeenCalled();
  });

  it("surfaces (warns, does not bill) a line whose quantity shrank below invoiced", async () => {
    mockDirtySelect.mockResolvedValue({
      data: [line({ quantity: 100, invoiced_quantity: 500, stripe_invoice_item_id: null })],
    });
    await syncOverageInvoiceItems("org_1");
    expect(mockItemCreate).not.toHaveBeenCalled();
    // Still clears dirty — nothing further to push for this line right now.
    expect(mockLineUpdate).toHaveBeenCalledWith({ dirty: false });
  });
});