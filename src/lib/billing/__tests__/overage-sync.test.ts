import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockDirtySelect,
  mockCustomerSelect,
  mockLineUpdate,
  mockLineUpdateFull,
  mockItemCreate,
  mockItemUpdate,
  mockItemRetrieve,
  mockGetBillingState,
  mockFrom,
  mockLinesSelectCols,
  mockLinesEq,
  mockCustomerSelectCols,
  mockCustomerEq,
  mockLogError,
  mockLogWarn,
} = vi.hoisted(() => ({
  mockDirtySelect: vi.fn(),
  mockCustomerSelect: vi.fn(),
  mockLineUpdate: vi.fn(),
  mockLineUpdateFull: vi.fn(),
  mockItemCreate: vi.fn(),
  mockItemUpdate: vi.fn(),
  mockItemRetrieve: vi.fn(),
  mockGetBillingState: vi.fn(),
  mockFrom: vi.fn(),
  mockLinesSelectCols: vi.fn(),
  mockLinesEq: vi.fn(),
  mockCustomerSelectCols: vi.fn(),
  mockCustomerEq: vi.fn(),
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      mockFrom(table);
      if (table === "overage_invoice_lines") {
        return {
          // .select(cols).eq("org_id", ...).eq("dirty", true) — record every arg
          select: (cols: string) => {
            mockLinesSelectCols(cols);
            return {
              eq: (c1: string, v1: unknown) => {
                mockLinesEq(c1, v1);
                return {
                  eq: (c2: string, v2: unknown) => {
                    mockLinesEq(c2, v2);
                    return mockDirtySelect();
                  },
                };
              },
            };
          },
          // .update({...}).eq×3 or ×4 — record the patch (and the full eq
          // filter chain) when awaited
          update: (patch: unknown) => {
            const eqs: unknown[][] = [];
            const chain = {
              eq: (col: string, val: unknown) => {
                eqs.push([col, val]);
                return chain;
              },
              then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
                mockLineUpdate(patch);
                mockLineUpdateFull(patch, eqs);
                return Promise.resolve({ error: null }).then(resolve, reject);
              },
            };
            return chain;
          },
        };
      }
      // customers
      return {
        select: (cols: string) => {
          mockCustomerSelectCols(cols);
          return {
            eq: (c: string, v: unknown) => {
              mockCustomerEq(c, v);
              return { maybeSingle: mockCustomerSelect };
            },
          };
        },
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
  log: { error: mockLogError, warn: mockLogWarn, info: vi.fn() },
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
    // The skip is a queryable warn, not a silent return (and not the outer
    // catch's error path, which a null-customer dereference would take).
    expect(mockLogWarn).toHaveBeenCalledWith(
      "overage push skipped — no Stripe customer",
      expect.objectContaining({ event: "billing.overage_push_skipped", org_id: "org_1" })
    );
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("a failed push leaves the line dirty for the next sync", async () => {
    mockDirtySelect.mockResolvedValue({ data: [line({ quantity: 10 })] });
    mockItemCreate.mockRejectedValue(new Error("stripe down"));
    await expect(syncOverageInvoiceItems("org_1")).resolves.toBeUndefined();
    expect(mockLineUpdate).not.toHaveBeenCalled();
    // The per-line catch logs the failure with meter context.
    expect(mockLogError).toHaveBeenCalledWith(
      "overage invoice item push failed",
      expect.objectContaining({
        event: "billing.overage_push_failed",
        org_id: "org_1",
        meter: "points",
      })
    );
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
    // Skipping is a warn with the meter named — not a crash into the outer
    // catch (which a bare currentRates.pointUnitUsd dereference would be).
    expect(mockLogWarn).toHaveBeenCalledWith(
      "overage push skipped — no unit rate (plan has no overage)",
      expect.objectContaining({
        event: "billing.overage_push_skipped",
        org_id: "org_1",
        meter: "points",
      })
    );
    expect(mockLogError).not.toHaveBeenCalled();
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
    // Exactly zero is fully invoiced, NOT underwater — no manual-credit warn.
    expect(mockLogWarn).not.toHaveBeenCalled();
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
    const dbErr = new Error("db down");
    mockDirtySelect.mockResolvedValue({ data: null, error: dbErr });
    await expect(syncOverageInvoiceItems("org_1")).resolves.toBeUndefined();
    expect(mockItemCreate).not.toHaveBeenCalled();
    // The fetch error is surfaced as a queryable error record, not swallowed
    // by the "no rows" early return below it.
    expect(mockLogError).toHaveBeenCalledWith(
      "overage lines fetch failed",
      expect.objectContaining({
        event: "billing.overage_lines_fetch_failed",
        org_id: "org_1",
        error: dbErr,
      })
    );
  });

  it("returns (never throws) when the customer lookup itself errors", async () => {
    const dbErr = new Error("db down");
    mockDirtySelect.mockResolvedValue({ data: [line()] });
    mockCustomerSelect.mockResolvedValue({ data: null, error: dbErr });
    await expect(syncOverageInvoiceItems("org_1")).resolves.toBeUndefined();
    expect(mockItemCreate).not.toHaveBeenCalled();
    // Lookup failure is an ERROR (not the no-customer warn a fallthrough
    // into the next guard would emit).
    expect(mockLogError).toHaveBeenCalledWith(
      "overage push skipped — customer lookup failed",
      expect.objectContaining({
        event: "billing.overage_customer_lookup_failed",
        org_id: "org_1",
        error: dbErr,
      })
    );
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("never throws — an unexpected error anywhere is caught at the top level", async () => {
    const boom = new Error("boom");
    mockDirtySelect.mockResolvedValue({ data: [line()] });
    mockGetBillingState.mockRejectedValue(boom);
    await expect(syncOverageInvoiceItems("org_1")).resolves.toBeUndefined();
    // The catch is not an empty swallow: it emits the sync-failed record.
    expect(mockLogError).toHaveBeenCalledWith(
      "overage invoice sync failed",
      expect.objectContaining({
        event: "billing.overage_sync_failed",
        org_id: "org_1",
        error: boom,
      })
    );
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
    // The underwater condition is surfaced with full quantities for the
    // operator deciding on a manual credit.
    expect(mockLogWarn).toHaveBeenCalledWith(
      "overage line below invoiced quantity — manual credit may be due",
      expect.objectContaining({
        event: "billing.overage_line_underwater",
        org_id: "org_1",
        meter: "points",
        quantity: 100,
        invoiced_quantity: 500,
      })
    );
  });

  it("queries exactly the dirty lines and customer row it needs (columns + filters)", async () => {
    mockDirtySelect.mockResolvedValue({ data: [line()] });
    await syncOverageInvoiceItems("org_1");

    expect(mockFrom).toHaveBeenCalledWith("overage_invoice_lines");
    expect(mockFrom).toHaveBeenCalledWith("customers");
    expect(mockLinesSelectCols).toHaveBeenCalledWith(
      "period_start, meter, quantity, unit_usd, stripe_invoice_item_id, invoiced_quantity"
    );
    // Org scoping + the dirty flag are both real filters, in order.
    expect(mockLinesEq).toHaveBeenNthCalledWith(1, "org_id", "org_1");
    expect(mockLinesEq).toHaveBeenNthCalledWith(2, "dirty", true);
    expect(mockCustomerSelectCols).toHaveBeenCalledWith("stripe_customer_id");
    expect(mockCustomerEq).toHaveBeenCalledWith("org_id", "org_1");
  });

  it("creates the item in usd with a description naming the meter and period", async () => {
    mockDirtySelect.mockResolvedValue({ data: [line()] });
    await syncOverageInvoiceItems("org_1");
    const [params] = mockItemCreate.mock.calls[0];
    expect(params.currency).toBe("usd");
    // "points" labels as Eval Point; the period renders short-month UTC.
    expect(params.description).toBe("Eval Point overage — period starting Jun 1, 2026");
  });

  it("labels a runs-meter create as Optimization Run", async () => {
    mockDirtySelect.mockResolvedValue({
      data: [line({ meter: "runs", quantity: 3, unit_usd: 1.5, stripe_invoice_item_id: null })],
    });
    await syncOverageInvoiceItems("org_1");
    const [params] = mockItemCreate.mock.calls[0];
    expect(params.description).toBe("Optimization Run overage — period starting Jun 1, 2026");
  });

  it("scopes the id-persist and dirty-clear updates to the exact line identity", async () => {
    mockDirtySelect.mockResolvedValue({ data: [line()] });
    await syncOverageInvoiceItems("org_1");
    // Id persist filters by (org, period, meter).
    expect(mockLineUpdateFull).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ stripe_invoice_item_id: "ii_new" }),
      [
        ["org_id", "org_1"],
        ["period_start", PERIOD],
        ["meter", "points"],
      ]
    );
    // Dirty clears only when quantity is still the pushed one (4th eq).
    expect(mockLineUpdateFull).toHaveBeenNthCalledWith(2, { dirty: false }, [
      ["org_id", "org_1"],
      ["period_start", PERIOD],
      ["meter", "points"],
      ["quantity", 2_000],
    ]);
  });

  it("scopes the finalized-item rollup update to the exact line identity", async () => {
    mockDirtySelect.mockResolvedValue({
      data: [line({ quantity: 2_500, stripe_invoice_item_id: "ii_old" })],
    });
    mockItemUpdate.mockRejectedValue(new Error("invoice is finalized"));
    mockItemRetrieve.mockResolvedValue({ id: "ii_old", invoice: "in_done", quantity: 2_000 });
    await syncOverageInvoiceItems("org_1");
    expect(mockLineUpdateFull).toHaveBeenCalledWith(
      { invoiced_quantity: 2_000, stripe_invoice_item_id: null },
      [
        ["org_id", "org_1"],
        ["period_start", PERIOD],
        ["meter", "points"],
      ]
    );
  });

  it("a line starting exactly 24h before invoice creation stays OFF the draft (strict <)", async () => {
    mockDirtySelect.mockResolvedValue({ data: [line()] });
    // (invoiceCreatedAt - 86_400) * 1000 lands exactly on period_start.
    await syncOverageInvoiceItems("org_1", {
      invoiceId: "in_draft",
      invoiceCreatedAt: new Date(PERIOD).getTime() / 1000 + 86_400,
    });
    const [params] = mockItemCreate.mock.calls[0];
    expect(params.invoice).toBeUndefined();
  });
});