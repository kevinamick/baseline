import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockDirtySelect,
  mockCustomerSelect,
  mockLineUpdate,
  mockItemCreate,
  mockItemUpdate,
  mockGetBillingState,
} = vi.hoisted(() => ({
  mockDirtySelect: vi.fn(),
  mockCustomerSelect: vi.fn(),
  mockLineUpdate: vi.fn(),
  mockItemCreate: vi.fn(),
  mockItemUpdate: vi.fn(),
  mockGetBillingState: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "overage_invoice_lines") {
        return {
          // .select(...).eq("org_id").eq("dirty", true)
          select: () => ({ eq: () => ({ eq: mockDirtySelect }) }),
          // .update({...}).eq×4
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
    invoiceItems: { create: mockItemCreate, update: mockItemUpdate },
  },
}));
vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));
vi.mock("@/lib/logging/server", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { syncOverageInvoiceItems } from "../overage-sync";
import { PLANS } from "../plans";

const PERIOD = "2026-06-01T00:00:00.000Z";

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
  it("creates an invoice item for a new line at the plan's unit rate", async () => {
    mockDirtySelect.mockResolvedValue({
      data: [
        { period_start: PERIOD, meter: "points", quantity: 2_000, stripe_invoice_item_id: null },
      ],
    });
    await syncOverageInvoiceItems("org_1");

    expect(mockItemCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_1",
        quantity: 2_000,
        // Builder's $0.0005/point in decimal cents.
        unit_amount_decimal: expect.objectContaining({}),
      })
    );
    const arg = mockItemCreate.mock.calls[0][0];
    // Stripe's Decimal normalizes trailing zeros; compare the value.
    expect(Number(String(arg.unit_amount_decimal))).toBe(
      PLANS.builder.evalPointOverageUsd! * 100
    );
    // dirty cleared with the pushed id, scoped to the pushed quantity.
    expect(mockLineUpdate).toHaveBeenCalledWith({
      stripe_invoice_item_id: "ii_new",
      dirty: false,
    });
  });

  it("updates the existing item in place — one line per (period, meter)", async () => {
    mockDirtySelect.mockResolvedValue({
      data: [
        { period_start: PERIOD, meter: "runs", quantity: 3, stripe_invoice_item_id: "ii_old" },
      ],
    });
    await syncOverageInvoiceItems("org_1");
    expect(mockItemUpdate).toHaveBeenCalledWith("ii_old", { quantity: 3 });
    expect(mockItemCreate).not.toHaveBeenCalled();
  });

  it("targets the draft invoice when given one (the invoice.created backstop)", async () => {
    mockDirtySelect.mockResolvedValue({
      data: [
        { period_start: PERIOD, meter: "points", quantity: 10, stripe_invoice_item_id: null },
      ],
    });
    await syncOverageInvoiceItems("org_1", { invoiceId: "in_draft" });
    expect(mockItemCreate).toHaveBeenCalledWith(
      expect.objectContaining({ invoice: "in_draft" })
    );
  });

  it("skips zero-quantity lines that never had an item, but clears them", async () => {
    mockDirtySelect.mockResolvedValue({
      data: [
        { period_start: PERIOD, meter: "points", quantity: 0, stripe_invoice_item_id: null },
      ],
    });
    await syncOverageInvoiceItems("org_1");
    expect(mockItemCreate).not.toHaveBeenCalled();
    expect(mockLineUpdate).toHaveBeenCalledWith({
      stripe_invoice_item_id: null,
      dirty: false,
    });
  });

  it("skips entirely (warning, not throw) when no Stripe customer exists", async () => {
    mockDirtySelect.mockResolvedValue({
      data: [
        { period_start: PERIOD, meter: "points", quantity: 10, stripe_invoice_item_id: null },
      ],
    });
    mockCustomerSelect.mockResolvedValue({ data: null, error: null });
    await expect(syncOverageInvoiceItems("org_1")).resolves.toBeUndefined();
    expect(mockItemCreate).not.toHaveBeenCalled();
    expect(mockLineUpdate).not.toHaveBeenCalled();
  });

  it("a failed push leaves the line dirty for the next sync", async () => {
    mockDirtySelect.mockResolvedValue({
      data: [
        { period_start: PERIOD, meter: "points", quantity: 10, stripe_invoice_item_id: null },
      ],
    });
    mockItemCreate.mockRejectedValue(new Error("stripe down"));
    await expect(syncOverageInvoiceItems("org_1")).resolves.toBeUndefined();
    expect(mockLineUpdate).not.toHaveBeenCalled();
  });
});