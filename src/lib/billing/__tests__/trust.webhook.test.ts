import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * applyTrustWebhook record-path unit tests (#188) — the bits that don't need a DB:
 * the $0-invoice guard (a coupon/trial invoice proves no card, so it never advances
 * trust) and the payment-intent capture, which MUST be reliable because refund /
 * dispute reversal finds the row only by PI. Stripe omits the `payments` sub-list
 * from the webhook payload, so the recorder re-fetches the invoice with it expanded;
 * these tests pin both the inline hit and the re-fetch fallback. (The DB-touching
 * record/reverse/isolation paths live in trust.integration.test.ts.)
 */

const { mockUpsert, mockCustomerMaybeSingle, mockInvoiceRetrieve } = vi.hoisted(
  () => ({
    mockUpsert: vi.fn(),
    mockCustomerMaybeSingle: vi.fn(),
    mockInvoiceRetrieve: vi.fn(),
  }),
);

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "customers") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: mockCustomerMaybeSingle }) }),
        };
      }
      // paid_invoices
      return {
        upsert: (payload: unknown, opts: unknown) => {
          mockUpsert(payload, opts);
          return Promise.resolve({ error: null });
        },
      };
    },
  },
}));

vi.mock("@/lib/stripe", () => ({
  stripe: { invoices: { retrieve: mockInvoiceRetrieve } },
}));

vi.mock("@/lib/logging/server", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const piPayment = (id: string) => ({
  payment: { type: "payment_intent", payment_intent: id },
});

const paidEvent = (invoice: Record<string, unknown>) =>
  ({
    id: `evt_${invoice.id}`,
    type: "invoice.paid",
    created: 1_700_000_000,
    data: { object: { customer: "cus_1", amount_paid: 4900, ...invoice } },
  }) as never;

describe("applyTrustWebhook — record path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCustomerMaybeSingle.mockResolvedValue({ data: { org_id: "org_1" }, error: null });
  });

  it("does not advance trust for a $0 invoice (coupon / trial proves no card)", async () => {
    const { applyTrustWebhook } = await import("@/lib/billing/trust");
    expect(
      await applyTrustWebhook(paidEvent({ id: "in_free", amount_paid: 0 })),
    ).toBe(true);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockInvoiceRetrieve).not.toHaveBeenCalled();
  });

  it("captures the PI from the inline payments list without re-fetching", async () => {
    const { applyTrustWebhook } = await import("@/lib/billing/trust");
    await applyTrustWebhook(
      paidEvent({ id: "in_inline", payments: { data: [piPayment("pi_inline")] } }),
    );
    expect(mockInvoiceRetrieve).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0]).toMatchObject({
      stripe_invoice_id: "in_inline",
      org_id: "org_1",
      stripe_payment_intent_id: "pi_inline",
    });
  });

  it("re-fetches with payments expanded when the webhook omits the sub-list", async () => {
    const { applyTrustWebhook } = await import("@/lib/billing/trust");
    mockInvoiceRetrieve.mockResolvedValue({
      id: "in_fetch",
      payments: { data: [piPayment("pi_fetched")] },
    });
    await applyTrustWebhook(paidEvent({ id: "in_fetch" })); // no inline payments

    expect(mockInvoiceRetrieve).toHaveBeenCalledWith("in_fetch", {
      expand: ["payments.data.payment.payment_intent"],
    });
    expect(mockUpsert.mock.calls[0][0]).toMatchObject({
      stripe_payment_intent_id: "pi_fetched",
    });
  });

  it("records with a null PI (still upserts) when Stripe surfaces none even on re-fetch", async () => {
    const { applyTrustWebhook } = await import("@/lib/billing/trust");
    mockInvoiceRetrieve.mockResolvedValue({ id: "in_nopi", payments: { data: [] } });
    await applyTrustWebhook(paidEvent({ id: "in_nopi" }));

    expect(mockInvoiceRetrieve).toHaveBeenCalledOnce();
    expect(mockUpsert.mock.calls[0][0]).toMatchObject({
      stripe_invoice_id: "in_nopi",
      stripe_payment_intent_id: null,
    });
  });

  it("ignores a charge-type payment when capturing the PI (re-fetches instead)", async () => {
    const { applyTrustWebhook } = await import("@/lib/billing/trust");
    mockInvoiceRetrieve.mockResolvedValue({
      id: "in_charge",
      payments: { data: [piPayment("pi_real")] },
    });
    await applyTrustWebhook(
      paidEvent({
        id: "in_charge",
        payments: { data: [{ payment: { type: "charge", charge: "ch_1" } }] },
      }),
    );
    expect(mockInvoiceRetrieve).toHaveBeenCalledOnce();
    expect(mockUpsert.mock.calls[0][0]).toMatchObject({
      stripe_payment_intent_id: "pi_real",
    });
  });
});
