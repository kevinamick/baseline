import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockRpc,
  mockLinesSelect,
  mockCustomerMaybeSingle,
  mockInvoiceCreate,
  mockItemCreate,
  mockFinalize,
  mockInvoiceRetrieve,
  mockGetBillingState,
  mockLogError,
  mockLogWarn,
  mockLogInfo,
} = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockLinesSelect: vi.fn(),
  mockCustomerMaybeSingle: vi.fn(),
  mockInvoiceCreate: vi.fn(),
  mockItemCreate: vi.fn(),
  mockFinalize: vi.fn(),
  mockInvoiceRetrieve: vi.fn(),
  mockGetBillingState: vi.fn(),
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogInfo: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  stripe: {
    invoices: { create: mockInvoiceCreate, finalizeInvoice: mockFinalize, retrieve: mockInvoiceRetrieve },
    invoiceItems: { create: mockItemCreate },
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    rpc: mockRpc,
    from: (table: string) => {
      if (table === "managed_invoice_lines") {
        return { select: () => ({ eq: () => ({ eq: mockLinesSelect }) }) };
      }
      // customers
      return { select: () => ({ eq: () => ({ maybeSingle: mockCustomerMaybeSingle }) }) };
    },
  },
}));
vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));
vi.mock("@/lib/logging/server", () => ({
  log: { info: mockLogInfo, warn: mockLogWarn, error: mockLogError },
}));

import { shouldBillManagedPeriod, orgsWithUninvoicedManagedSpend, syncManagedInvoiceLines } from "../managed-invoice-sync";

/**
 * Threshold-billing trigger logic (#186). Bill now when un-invoiced accrued
 * managed spend crosses the plan threshold (bounding extended credit) OR the
 * period has ended (month-end flush of any sub-threshold remainder).
 */
describe("shouldBillManagedPeriod", () => {
  const BUILDER_THRESHOLD = 10;

  it("does not bill while un-invoiced spend is below the threshold mid-period", () => {
    expect(shouldBillManagedPeriod(9.99, BUILDER_THRESHOLD, false)).toBe(false);
  });

  it("bills the moment un-invoiced spend reaches the threshold", () => {
    expect(shouldBillManagedPeriod(10, BUILDER_THRESHOLD, false)).toBe(true);
    expect(shouldBillManagedPeriod(12.5, BUILDER_THRESHOLD, false)).toBe(true);
  });

  it("flushes a sub-threshold remainder once the period has ended", () => {
    expect(shouldBillManagedPeriod(3.21, BUILDER_THRESHOLD, true)).toBe(true);
  });

  it("never bills a fully-invoiced (zero un-invoiced) period, even at period end", () => {
    expect(shouldBillManagedPeriod(0, BUILDER_THRESHOLD, true)).toBe(false);
    // Sub-cent float noise is not billable spend.
    expect(shouldBillManagedPeriod(1e-9, BUILDER_THRESHOLD, true)).toBe(false);
  });

  it("a plan with no threshold (BYO-only) only bills at period end", () => {
    expect(shouldBillManagedPeriod(50, null, false)).toBe(false);
    expect(shouldBillManagedPeriod(50, null, true)).toBe(true);
  });
});

describe("orgsWithUninvoicedManagedSpend", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps the candidate rows to org ids", async () => {
    mockRpc.mockResolvedValue({ data: [{ org_id: "org_1" }, { org_id: "org_2" }], error: null });
    expect(await orgsWithUninvoicedManagedSpend()).toEqual(["org_1", "org_2"]);
  });

  it("is empty (not throwing) on an RPC error", async () => {
    mockRpc.mockResolvedValue({ data: null, error: new Error("db down") });
    expect(await orgsWithUninvoicedManagedSpend()).toEqual([]);
    expect(mockLogError).toHaveBeenCalled();
  });

  it("is empty when data is null", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    expect(await orgsWithUninvoicedManagedSpend()).toEqual([]);
  });
});

const PERIOD_PAST = {
  start: "2026-05-01T00:00:00.000Z",
  end: "2026-06-01T00:00:00.000Z", // already ended relative to the fixed clock below
};
const PERIOD_OPEN = {
  start: "2026-06-01T00:00:00.000Z",
  end: "2099-01-01T00:00:00.000Z", // far future — still open
};

function invoiceLine(overrides: Record<string, unknown> = {}) {
  return {
    org_id: "org_1",
    period_start: PERIOD_PAST.start,
    period_end: PERIOD_PAST.end,
    provider: "anthropic",
    model: "claude",
    accrued_usd: 12,
    invoiced_usd: 0,
    ...overrides,
  };
}

describe("syncManagedInvoiceLines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00.000Z"));
    mockGetBillingState.mockResolvedValue({ plan: "builder" }); // threshold $10
    mockCustomerMaybeSingle.mockResolvedValue({
      data: { stripe_customer_id: "cus_1", managed_payment_failed_at: null },
      error: null,
    });
    mockInvoiceCreate.mockResolvedValue({ id: "in_new", status: "draft" });
    mockItemCreate.mockResolvedValue({ id: "ii_1" });
    mockFinalize.mockResolvedValue({});
    mockRpc.mockResolvedValue({ error: null });
  });

  afterEach(() => vi.useRealTimers());

  it("returns early when the fetch itself errors", async () => {
    mockLinesSelect.mockResolvedValue({ data: null, error: new Error("db down") });
    await syncManagedInvoiceLines("org_1");
    expect(mockLogError).toHaveBeenCalled();
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
  });

  it("is a no-op with no dirty rows", async () => {
    mockLinesSelect.mockResolvedValue({ data: [], error: null });
    await syncManagedInvoiceLines("org_1");
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
  });

  it("skips lines already fully invoiced (accrued − invoiced ≤ epsilon)", async () => {
    mockLinesSelect.mockResolvedValue({ data: [invoiceLine({ accrued_usd: 5, invoiced_usd: 5 })], error: null });
    await syncManagedInvoiceLines("org_1");
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
    expect(mockGetBillingState).not.toHaveBeenCalled();
  });

  it("logs and returns when the customer lookup errors", async () => {
    mockLinesSelect.mockResolvedValue({ data: [invoiceLine()], error: null });
    mockCustomerMaybeSingle.mockResolvedValue({ data: null, error: new Error("db down") });
    await syncManagedInvoiceLines("org_1");
    expect(mockLogError).toHaveBeenCalled();
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
  });

  it("warns and returns when there is no Stripe customer", async () => {
    mockLinesSelect.mockResolvedValue({ data: [invoiceLine()], error: null });
    mockCustomerMaybeSingle.mockResolvedValue({ data: null, error: null });
    await syncManagedInvoiceLines("org_1");
    expect(mockLogWarn).toHaveBeenCalled();
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
  });

  it("skips (does not stack a second invoice) while a managed payment is already failing", async () => {
    mockLinesSelect.mockResolvedValue({ data: [invoiceLine()], error: null });
    mockCustomerMaybeSingle.mockResolvedValue({
      data: { stripe_customer_id: "cus_1", managed_payment_failed_at: "2026-06-10T00:00:00.000Z" },
      error: null,
    });
    await syncManagedInvoiceLines("org_1");
    expect(mockLogInfo).toHaveBeenCalled();
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
  });

  it("does not bill a period below threshold that hasn't ended", async () => {
    mockLinesSelect.mockResolvedValue({
      data: [invoiceLine({ accrued_usd: 3, period_start: PERIOD_OPEN.start, period_end: PERIOD_OPEN.end })],
      error: null,
    });
    await syncManagedInvoiceLines("org_1");
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
  });

  it("bills a closed period even sub-threshold (month-end flush)", async () => {
    mockLinesSelect.mockResolvedValue({ data: [invoiceLine({ accrued_usd: 3 })], error: null });
    await syncManagedInvoiceLines("org_1");
    expect(mockInvoiceCreate).toHaveBeenCalledTimes(1);
  });

  it("creates one invoice per period, itemized, and advances the watermark", async () => {
    mockLinesSelect.mockResolvedValue({
      data: [
        invoiceLine({ accrued_usd: 12, invoiced_usd: 2 }),
        invoiceLine({ provider: "openai", model: "gpt", accrued_usd: 8 }),
      ],
      error: null,
    });
    await syncManagedInvoiceLines("org_1");

    expect(mockInvoiceCreate).toHaveBeenCalledTimes(1);
    const [createParams, createOpts] = mockInvoiceCreate.mock.calls[0];
    expect(createParams).toMatchObject({ customer: "cus_1", collection_method: "charge_automatically" });
    expect(createOpts.idempotencyKey).toBe(`mgd-inv1:org_1:${PERIOD_PAST.start}:200`);

    expect(mockItemCreate).toHaveBeenCalledTimes(2);
    for (const [params] of mockItemCreate.mock.calls) {
      expect(params.invoice).toBe("in_new");
    }

    expect(mockFinalize).toHaveBeenCalledWith("in_new", { auto_advance: true });
    expect(mockRpc).toHaveBeenCalledWith(
      "mark_managed_line_invoiced",
      expect.objectContaining({ p_org_id: "org_1", p_provider: "anthropic", p_amount: 10 })
    );
    expect(mockRpc).toHaveBeenCalledWith(
      "mark_managed_line_invoiced",
      expect.objectContaining({ p_provider: "openai", p_amount: 8 })
    );
    expect(mockLogInfo).toHaveBeenCalledWith(
      "managed token invoice issued",
      expect.objectContaining({ line_count: 2 })
    );
  });

  it("groups lines by period_start into separate invoices", async () => {
    mockLinesSelect.mockResolvedValue({
      data: [
        invoiceLine({ accrued_usd: 12 }), // closed period → bills
        invoiceLine({ period_start: PERIOD_OPEN.start, period_end: PERIOD_OPEN.end, accrued_usd: 3 }), // open, sub-threshold → skipped
      ],
      error: null,
    });
    await syncManagedInvoiceLines("org_1");
    expect(mockInvoiceCreate).toHaveBeenCalledTimes(1);
    expect(mockInvoiceCreate.mock.calls[0][1].idempotencyKey).toContain(PERIOD_PAST.start);
  });

  it("leaves lines dirty (returns) when invoice create fails", async () => {
    mockLinesSelect.mockResolvedValue({ data: [invoiceLine()], error: null });
    mockInvoiceCreate.mockRejectedValue(new Error("stripe down"));
    await syncManagedInvoiceLines("org_1");
    expect(mockLogError).toHaveBeenCalled();
    expect(mockItemCreate).not.toHaveBeenCalled();
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it("continues billing the rest when one line's item create fails; never finalizes if all fail", async () => {
    mockLinesSelect.mockResolvedValue({ data: [invoiceLine()], error: null });
    mockItemCreate.mockRejectedValue(new Error("stripe down"));
    await syncManagedInvoiceLines("org_1");
    expect(mockLogError).toHaveBeenCalled();
    expect(mockFinalize).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalledWith("mark_managed_line_invoiced", expect.anything());
  });

  it("crash-resume: an already-finalized invoice on retry still advances the watermark", async () => {
    mockLinesSelect.mockResolvedValue({ data: [invoiceLine()], error: null });
    mockFinalize.mockRejectedValue(new Error("invoice already finalized"));
    mockInvoiceRetrieve.mockResolvedValue({ status: "paid" });
    await syncManagedInvoiceLines("org_1");
    expect(mockRpc).toHaveBeenCalledWith("mark_managed_line_invoiced", expect.anything());
  });

  it("leaves the watermark untouched when finalize fails and the invoice is still a draft", async () => {
    mockLinesSelect.mockResolvedValue({ data: [invoiceLine()], error: null });
    mockFinalize.mockRejectedValue(new Error("card declined"));
    mockInvoiceRetrieve.mockResolvedValue({ status: "draft" });
    await syncManagedInvoiceLines("org_1");
    expect(mockLogError).toHaveBeenCalledWith(
      "managed invoice finalize failed",
      expect.objectContaining({ org_id: "org_1" })
    );
    expect(mockRpc).not.toHaveBeenCalledWith("mark_managed_line_invoiced", expect.anything());
  });

  it("leaves the watermark untouched when finalize fails and the re-fetch also fails", async () => {
    mockLinesSelect.mockResolvedValue({ data: [invoiceLine()], error: null });
    mockFinalize.mockRejectedValue(new Error("card declined"));
    mockInvoiceRetrieve.mockRejectedValue(new Error("network"));
    await syncManagedInvoiceLines("org_1");
    expect(mockRpc).not.toHaveBeenCalledWith("mark_managed_line_invoiced", expect.anything());
  });

  it("logs but never throws when the watermark RPC itself errors", async () => {
    mockLinesSelect.mockResolvedValue({ data: [invoiceLine()], error: null });
    mockRpc.mockResolvedValue({ error: new Error("db down") });
    await expect(syncManagedInvoiceLines("org_1")).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalledWith(
      "managed invoice watermark advance failed",
      expect.objectContaining({ org_id: "org_1" })
    );
  });

  it("never throws — an unexpected error anywhere is caught at the top level", async () => {
    mockLinesSelect.mockResolvedValue({ data: [invoiceLine()], error: null });
    mockGetBillingState.mockRejectedValue(new Error("boom"));
    await expect(syncManagedInvoiceLines("org_1")).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalledWith(
      "managed invoice sync failed",
      expect.objectContaining({ org_id: "org_1" })
    );
  });
});
