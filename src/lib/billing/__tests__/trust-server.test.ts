import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Server-seam coverage for trust.ts (#188) that trust.webhook.test.ts (the
 * PI-capture record path) and trust.integration.test.ts (DB-backed) don't hit:
 * getPaidInvoiceCount's error path, getTrustStatus's composition, and the
 * reversal event types (void/uncollectible/refund/dispute) plus the unknown-
 * event default. All I/O mocked — no DB, no Stripe.
 */

const {
  mockCountSelect,
  mockUpsert,
  mockUpdateEq,
  mockCustomerMaybeSingle,
  mockGetBillingState,
  mockInvoiceRetrieve,
  mockLogError,
} = vi.hoisted(() => ({
  mockCountSelect: vi.fn(),
  mockUpsert: vi.fn(),
  mockUpdateEq: vi.fn(),
  mockCustomerMaybeSingle: vi.fn(),
  mockGetBillingState: vi.fn(),
  mockInvoiceRetrieve: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "paid_invoices") {
        return {
          select: () => ({ eq: () => ({ is: mockCountSelect }) }),
          upsert: mockUpsert,
          update: () => ({ is: () => ({ eq: mockUpdateEq }) }),
        };
      }
      // customers
      return { select: () => ({ eq: () => ({ maybeSingle: mockCustomerMaybeSingle }) }) };
    },
  },
}));
vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));
vi.mock("@/lib/stripe", () => ({ stripe: { invoices: { retrieve: mockInvoiceRetrieve } } }));
vi.mock("@/lib/logging/server", () => ({
  log: { error: mockLogError, warn: vi.fn(), info: vi.fn() },
}));

import { getPaidInvoiceCount, getTrustStatus, applyTrustWebhook } from "../trust";
import { PLANS } from "../plans";

beforeEach(() => vi.clearAllMocks());

describe("getPaidInvoiceCount", () => {
  it("returns the count of un-reversed invoices", async () => {
    mockCountSelect.mockResolvedValue({ count: 3, error: null });
    expect(await getPaidInvoiceCount("org_1")).toBe(3);
  });

  it("defaults a null count to zero", async () => {
    mockCountSelect.mockResolvedValue({ count: null, error: null });
    expect(await getPaidInvoiceCount("org_1")).toBe(0);
  });

  it("fails closed to zero (no trust) on a read error", async () => {
    mockCountSelect.mockResolvedValue({ count: null, error: { message: "db down" } });
    expect(await getPaidInvoiceCount("org_1")).toBe(0);
    expect(mockLogError).toHaveBeenCalled();
  });
});

describe("getTrustStatus", () => {
  it("composes plan, history, ceiling, and next tier", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "builder" });
    mockCountSelect.mockResolvedValue({ count: 2, error: null });
    const status = await getTrustStatus("org_1");
    expect(status).toEqual({
      plan: "builder",
      paidInvoices: 2,
      ceilingUsd: PLANS.builder.defaultManagedSpendCapUsd! * 2,
      defaultCapUsd: PLANS.builder.defaultManagedSpendCapUsd,
      nextTier: { atPaidInvoices: 4, ceilingUsd: PLANS.builder.defaultManagedSpendCapUsd! * 4 },
    });
  });

  it("is null-ceilinged for a Free Team with no managed spend", async () => {
    mockGetBillingState.mockResolvedValue({ plan: "free" });
    mockCountSelect.mockResolvedValue({ count: 0, error: null });
    const status = await getTrustStatus("org_1");
    expect(status.ceilingUsd).toBeNull();
    expect(status.nextTier).toBeNull();
  });
});

describe("applyTrustWebhook — record path edge cases", () => {
  beforeEach(() => {
    mockCustomerMaybeSingle.mockResolvedValue({ data: { org_id: "org_1" }, error: null });
  });

  it("logs (but does not throw) when the upsert itself errors", async () => {
    mockUpsert.mockResolvedValue({ error: { message: "db down" } });
    const event = {
      id: "evt_upsert_fail",
      type: "invoice.paid",
      created: 1_700_000_000,
      data: { object: { id: "in_1", customer: "cus_1", amount_paid: 4900 } },
    } as never;
    await expect(applyTrustWebhook(event)).resolves.toBe(true);
    expect(mockLogError).toHaveBeenCalledWith(
      "paid invoice record failed",
      expect.objectContaining({ stripe_invoice_id: "in_1" })
    );
  });

  it("records with a null PI (logging the failure) when the re-fetch itself throws", async () => {
    mockUpsert.mockResolvedValue({ error: null });
    mockInvoiceRetrieve.mockRejectedValue(new Error("stripe down"));
    const event = {
      id: "evt_pi_fetch_fail",
      type: "invoice.paid",
      created: 1_700_000_000,
      data: { object: { id: "in_2", customer: "cus_1", amount_paid: 4900 } }, // no inline payments
    } as never;
    await expect(applyTrustWebhook(event)).resolves.toBe(true);
    expect(mockLogError).toHaveBeenCalledWith(
      "invoice payment-intent lookup failed",
      expect.objectContaining({ stripe_invoice_id: "in_2" })
    );
    expect(mockUpsert.mock.calls[0][0]).toMatchObject({ stripe_payment_intent_id: null });
  });

  it("resolves an expanded customer object (not just a bare id string)", async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const event = {
      id: "evt_obj_customer",
      type: "invoice.paid",
      created: 1_700_000_000,
      data: { object: { id: "in_obj", customer: { id: "cus_obj" }, amount_paid: 4900 } },
    } as never;
    expect(await applyTrustWebhook(event)).toBe(true);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the invoice carries no customer at all", async () => {
    const event = {
      id: "evt_no_customer",
      type: "invoice.paid",
      created: 1_700_000_000,
      data: { object: { id: "in_nocust", customer: null, amount_paid: 4900 } },
    } as never;
    expect(await applyTrustWebhook(event)).toBe(true);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("falls back to amount_due when amount_paid is absent", async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const event = {
      id: "evt_amount_due",
      type: "invoice.paid",
      created: 1_700_000_000,
      data: { object: { id: "in_due", customer: "cus_1", amount_due: 2500 } },
    } as never;
    expect(await applyTrustWebhook(event)).toBe(true);
    expect(mockUpsert.mock.calls[0][0]).toMatchObject({ amount_usd: 25 });
  });

  it("treats an invoice with neither amount_paid nor amount_due as $0 (no trust)", async () => {
    const event = {
      id: "evt_no_amount",
      type: "invoice.paid",
      created: 1_700_000_000,
      data: { object: { id: "in_zero", customer: "cus_1" } },
    } as never;
    expect(await applyTrustWebhook(event)).toBe(true);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("returns false (never throws) when the customer-lookup query itself errors", async () => {
    mockCustomerMaybeSingle.mockResolvedValue({ data: null, error: { message: "db down" } });
    const event = {
      id: "evt_cust_lookup_fail",
      type: "invoice.paid",
      created: 1_700_000_000,
      data: { object: { id: "in_3", customer: "cus_1", amount_paid: 4900 } },
    } as never;
    expect(await applyTrustWebhook(event)).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      "trust webhook side-effect failed",
      expect.objectContaining({ stripe_event_id: "evt_cust_lookup_fail" })
    );
  });
});

describe("applyTrustWebhook — reversal paths and dispatch", () => {
  beforeEach(() => {
    mockUpdateEq.mockResolvedValue({ error: null });
  });

  it("a paid event with no invoice id is a no-op true", async () => {
    const event = {
      id: "evt_paid_noid",
      type: "invoice.paid",
      created: 1_700_000_000,
      data: { object: { amount_paid: 4900 } },
    } as never;
    expect(await applyTrustWebhook(event)).toBe(true);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("a dispute with no payment intent is a no-op true (no row to find)", async () => {
    const event = {
      id: "evt_disp_nopi",
      type: "charge.dispute.created",
      data: { object: {} },
    } as never;
    expect(await applyTrustWebhook(event)).toBe(true);
    expect(mockUpdateEq).not.toHaveBeenCalled();
  });

  it("reverses by invoice id on invoice.voided", async () => {
    const event = {
      id: "evt_void",
      type: "invoice.voided",
      data: { object: { id: "in_1" } },
    } as never;
    expect(await applyTrustWebhook(event)).toBe(true);
    expect(mockUpdateEq).toHaveBeenCalledWith("stripe_invoice_id", "in_1");
  });

  it("reverses by invoice id on invoice.marked_uncollectible", async () => {
    const event = {
      id: "evt_unc",
      type: "invoice.marked_uncollectible",
      data: { object: { id: "in_2" } },
    } as never;
    expect(await applyTrustWebhook(event)).toBe(true);
    expect(mockUpdateEq).toHaveBeenCalledWith("stripe_invoice_id", "in_2");
  });

  it("a voided/uncollectible event with no invoice id is a no-op true", async () => {
    const event = { id: "evt_x", type: "invoice.voided", data: { object: {} } } as never;
    expect(await applyTrustWebhook(event)).toBe(true);
    expect(mockUpdateEq).not.toHaveBeenCalled();
  });

  it("reverses by payment intent on charge.refunded", async () => {
    const event = {
      id: "evt_ref",
      type: "charge.refunded",
      data: { object: { payment_intent: "pi_1" } },
    } as never;
    expect(await applyTrustWebhook(event)).toBe(true);
    expect(mockUpdateEq).toHaveBeenCalledWith("stripe_payment_intent_id", "pi_1");
  });

  it("a refund with no payment intent is a no-op true (no row to find)", async () => {
    const event = { id: "evt_ref2", type: "charge.refunded", data: { object: {} } } as never;
    expect(await applyTrustWebhook(event)).toBe(true);
    expect(mockUpdateEq).not.toHaveBeenCalled();
  });

  it("reverses by payment intent on charge.dispute.created", async () => {
    const event = {
      id: "evt_disp",
      type: "charge.dispute.created",
      data: { object: { payment_intent: "pi_2" } },
    } as never;
    expect(await applyTrustWebhook(event)).toBe(true);
    expect(mockUpdateEq).toHaveBeenCalledWith("stripe_payment_intent_id", "pi_2");
  });

  it("logs but does not throw when a reversal write fails", async () => {
    mockUpdateEq.mockResolvedValue({ error: { message: "db down" } });
    const event = {
      id: "evt_void_fail",
      type: "invoice.voided",
      data: { object: { id: "in_3" } },
    } as never;
    await expect(applyTrustWebhook(event)).resolves.toBe(true);
    expect(mockLogError).toHaveBeenCalled();
  });

  it("returns false, unrecognised, for an event type it doesn't handle", async () => {
    const event = { id: "evt_other", type: "customer.updated", data: { object: {} } } as never;
    expect(await applyTrustWebhook(event)).toBe(false);
  });

  it("returns false (never throws) when the handler itself throws", async () => {
    mockUpdateEq.mockRejectedValue(new Error("boom"));
    const event = {
      id: "evt_throw",
      type: "invoice.voided",
      data: { object: { id: "in_4" } },
    } as never;
    expect(await applyTrustWebhook(event)).toBe(false);
    expect(mockLogError).toHaveBeenCalled();
  });

  it("a paid-invoice event with no resolvable org is a no-op true", async () => {
    mockCustomerMaybeSingle.mockResolvedValue({ data: null, error: null });
    const event = {
      id: "evt_paid_noorg",
      type: "invoice.paid",
      created: 1_700_000_000,
      data: { object: { id: "in_5", customer: "cus_unmirrored", amount_paid: 4900 } },
    } as never;
    expect(await applyTrustWebhook(event)).toBe(true);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
