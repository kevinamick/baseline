import { describe, it, expect, vi, beforeEach } from "vitest";
import Stripe from "stripe";

// Real signature verification: set the secrets BEFORE @/lib/stripe is imported
// (vi.hoisted runs before module evaluation). We deliberately do NOT mock
// @/lib/stripe or @/lib/billing/webhook — this exercises the genuine Stripe HMAC
// path and the real event→mirror mapping. Only the DB and observability, plus the
// downstream billing side-effect modules (retention, seats, notifications, overage
// sync — each has its own unit tests), are faked.
const { dbRef } = vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY ??= "sk_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
  return { dbRef: { current: null as unknown as FakeDb } };
});

const {
  mockApplyRetention,
  mockCountMembers,
  mockNotifyLimitOnce,
  mockNotifyManagedPaymentFailed,
  mockSyncOverageInvoiceItems,
} = vi.hoisted(() => ({
  mockApplyRetention: vi.fn(),
  mockCountMembers: vi.fn(),
  mockNotifyLimitOnce: vi.fn(),
  mockNotifyManagedPaymentFailed: vi.fn(),
  mockSyncOverageInvoiceItems: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/analytics/server", () => ({ track: vi.fn() }));
vi.mock("@/lib/logging/server", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (t: string) => dbRef.current.from(t),
    rpc: (name: string, args: unknown) => dbRef.current.rpc(name, args),
  },
}));
vi.mock("@/lib/billing/retention", () => ({
  applyRetentionForPlanChange: mockApplyRetention,
}));
vi.mock("@/lib/billing/seats", () => ({ countMembers: mockCountMembers }));
vi.mock("@/lib/billing/limit-notifications", () => ({
  notifyLimitOnce: mockNotifyLimitOnce,
}));
vi.mock("@/lib/billing/managed-spend", () => ({
  notifyManagedPaymentFailed: mockNotifyManagedPaymentFailed,
}));
vi.mock("@/lib/billing/overage-sync", () => ({
  syncOverageInvoiceItems: mockSyncOverageInvoiceItems,
}));

import { POST } from "../route";
import { log } from "@/lib/logging/server";

const SECRET = "whsec_test_secret";
const signer = new Stripe("sk_test_dummy");

interface CustomerRow {
  org_id?: string;
  stripe_customer_id?: string;
  stripe_subscription_id?: string | null;
  status?: string;
  stripe_price_id?: string | null;
  managed_payment_failed_at?: string | null;
  managed_failed_invoice_id?: string | null;
  [k: string]: unknown;
}

// Faithful enough in-memory stand-in for the two tables the route touches (the
// vitest job has no live Postgres). Models the customers PK (org_id) and the
// billing_events unique id, so dedupe and "no duplicate rows" are real here.
// The force* flags let individual tests inject the DB-error branches the route
// guards against without a live Postgres.
class FakeDb {
  customers = new Map<string, CustomerRow>();
  events = new Set<string>();
  rpcCalls: Array<{ name: string; args: unknown }> = [];

  forceSeenError = false;
  forceCustomersSelectError = false;
  forceMirrorWriteError = false;
  forceLedgerInsertError: { code: string } | null = null;
  forceRpcError = false;

  from(table: string) {
    if (table === "billing_events") {
      return {
        select: () => ({
          eq: (_c: string, id: string) => ({
            maybeSingle: async () => {
              if (this.forceSeenError) {
                return { data: null, error: { message: "idempotency check boom" } };
              }
              return {
                data: this.events.has(id) ? { stripe_event_id: id } : null,
                error: null,
              };
            },
          }),
        }),
        insert: async (row: { stripe_event_id: string }) => {
          if (this.forceLedgerInsertError) return { error: this.forceLedgerInsertError };
          if (this.events.has(row.stripe_event_id))
            return { error: { code: "23505" } };
          this.events.add(row.stripe_event_id);
          return { error: null };
        },
      };
    }
    // customers
    const find = (col: string, val: string): CustomerRow | null => {
      for (const v of this.customers.values()) {
        if ((v as Record<string, unknown>)[col] === val) return v;
      }
      return null;
    };
    return {
      select: () => ({
        eq: (col: string, val: string) => ({
          maybeSingle: async () => {
            if (this.forceCustomersSelectError) {
              return { data: null, error: { message: "select boom" } };
            }
            return { data: find(col, val), error: null };
          },
        }),
      }),
      upsert: async (patch: CustomerRow) => {
        if (this.forceMirrorWriteError) return { error: { message: "upsert boom" } };
        const prev = this.customers.get(patch.org_id!) ?? {};
        this.customers.set(patch.org_id!, { ...prev, ...patch });
        return { error: null };
      },
      update: (patch: CustomerRow) => ({
        eq: async (_col: string, custId: string) => {
          if (this.forceMirrorWriteError) return { error: { message: "update boom" } };
          for (const [k, v] of this.customers) {
            if (v.stripe_customer_id === custId)
              this.customers.set(k, { ...v, ...patch });
          }
          return { error: null };
        },
      }),
    };
  }

  rpc(name: string, args: unknown) {
    this.rpcCalls.push({ name, args });
    if (this.forceRpcError) return Promise.resolve({ error: { message: "rpc boom" } });
    return Promise.resolve({ error: null });
  }
}

function rawOf(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

function signedReq(raw: string, secret = SECRET): Request {
  const sig = signer.webhooks.generateTestHeaderString({ payload: raw, secret });
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": sig },
    body: raw,
  });
}

const checkoutEvent = (id = "evt_co", created = 1000) => ({
  id,
  created,
  type: "checkout.session.completed",
  data: {
    object: {
      client_reference_id: "org-1",
      customer: "cus_1",
      subscription: "sub_1",
      customer_email: "buyer@acme.com",
    },
  },
});

const subEvent = (
  type:
    | "customer.subscription.updated"
    | "customer.subscription.deleted",
  id = "evt_sub",
  created = 2000,
  status = "active",
  priceId = "price_builder"
) => ({
  id,
  created,
  type,
  data: {
    object: {
      id: "sub_1",
      customer: "cus_1",
      status,
      metadata: { org_id: "org-1" },
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_592_000,
      items: { data: [{ price: { id: priceId } }] },
    },
  },
});

const subUpdatedEvent = (id = "evt_sub", created = 2000) =>
  subEvent("customer.subscription.updated", id, created, "active");

// A managed-token invoice decline (#186): sets managed_payment_failed_at, leaves
// `status` untouched.
const managedFailedEvent = (id = "evt_mf", created = 2500, invoiceId = "in_1") => ({
  id,
  created,
  type: "invoice.payment_failed",
  data: {
    object: {
      id: invoiceId,
      customer: "cus_1",
      metadata: { kind: "managed_tokens" },
      amount_due: 500,
    },
  },
});

// A managed-token invoice paid (#186 recovery). amount_paid: 0 keeps the
// (unmocked, real) trust webhook's paid-invoice recording a no-op so it never
// touches the customers/paid_invoices tables here.
const managedPaidEvent = (id = "evt_mp", created = 2600, invoiceId = "in_1") => ({
  id,
  created,
  type: "invoice.paid",
  data: {
    object: {
      id: invoiceId,
      customer: "cus_1",
      metadata: { kind: "managed_tokens" },
      amount_paid: 0,
    },
  },
});

const invoiceCreatedEvent = (
  id = "evt_ic",
  created = 4000,
  billingReason = "subscription_cycle",
  invoiceId = "in_cycle"
) => ({
  id,
  created,
  type: "invoice.created",
  data: {
    object: {
      id: invoiceId,
      customer: "cus_1",
      billing_reason: billingReason,
      created,
    },
  },
});

beforeEach(() => {
  dbRef.current = new FakeDb();
  vi.clearAllMocks();
  mockCountMembers.mockResolvedValue(0);
});

describe("POST /api/webhooks/stripe (integration: real signature + mirror)", () => {
  it("rejects a request with no stripe-signature header", async () => {
    const res = await POST(
      new Request("http://localhost/api/webhooks/stripe", {
        method: "POST",
        body: rawOf(checkoutEvent()),
      })
    );
    expect(res.status).toBe(400);
    expect(dbRef.current.customers.size).toBe(0);
  });

  it("rejects an invalid/tampered payload whose body no longer matches the signature", async () => {
    // Sign the original, then send a mutated body — the HMAC must not verify.
    const original = rawOf(checkoutEvent());
    const sig = signer.webhooks.generateTestHeaderString({
      payload: original,
      secret: SECRET,
    });
    const tampered = rawOf({
      ...checkoutEvent(),
      data: { object: { client_reference_id: "org-ATTACKER" } },
    });
    const res = await POST(
      new Request("http://localhost/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": sig },
        body: tampered,
      })
    );
    expect(res.status).toBe(400);
    expect(dbRef.current.customers.size).toBe(0);
  });

  it("rejects a payload signed with the wrong secret", async () => {
    const raw = rawOf(checkoutEvent());
    const res = await POST(signedReq(raw, "whsec_wrong"));
    expect(res.status).toBe(400);
    expect(dbRef.current.customers.size).toBe(0);
  });

  it("mirrors a signed checkout then activates on subscription.updated", async () => {
    const r1 = await POST(signedReq(rawOf(checkoutEvent())));
    expect(r1.status).toBe(200);
    const afterCheckout = dbRef.current.customers.get("org-1")!;
    expect(afterCheckout.stripe_customer_id).toBe("cus_1");
    expect(afterCheckout.stripe_subscription_id).toBe("sub_1");
    // Not active yet — status arrives with the subscription event.
    expect(afterCheckout.status).toBeUndefined();

    const r2 = await POST(signedReq(rawOf(subUpdatedEvent())));
    expect(r2.status).toBe(200);
    const active = dbRef.current.customers.get("org-1")!;
    expect(active.status).toBe("active");
    expect(active.stripe_price_id).toBe("price_builder");
    expect(dbRef.current.customers.size).toBe(1);
  });

  it("is idempotent: a replayed event id is acknowledged without re-applying", async () => {
    await POST(signedReq(rawOf(subUpdatedEvent("evt_replay"))));
    expect(dbRef.current.customers.get("org-1")!.status).toBe("active");

    // Simulate a downstream change, then replay the *same* event id. A replay
    // must be a no-op, so it must NOT clobber the row back.
    dbRef.current.customers.set("org-1", {
      ...dbRef.current.customers.get("org-1")!,
      status: "past_due",
    });
    const replay = await POST(signedReq(rawOf(subUpdatedEvent("evt_replay"))));
    expect(replay.status).toBe(200);
    expect(dbRef.current.customers.get("org-1")!.status).toBe("past_due");
    expect(dbRef.current.customers.size).toBe(1);
    expect(dbRef.current.events.size).toBe(1);
  });

  it("flips the mirror to past_due on invoice.payment_failed (update by customer)", async () => {
    await POST(signedReq(rawOf(checkoutEvent())));
    await POST(signedReq(rawOf(subUpdatedEvent())));
    expect(dbRef.current.customers.get("org-1")!.status).toBe("active");

    const invoiceFailed = {
      id: "evt_inv",
      created: 3000,
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_1", subscription: "sub_1" } },
    };
    const res = await POST(signedReq(rawOf(invoiceFailed)));
    expect(res.status).toBe(200);
    expect(dbRef.current.customers.get("org-1")!.status).toBe("past_due");
  });

  it("ignores a stale (older) status event so a late update can't un-cancel a Team", async () => {
    // Team is canceled at created=3000.
    await POST(signedReq(rawOf(subEvent("customer.subscription.deleted", "evt_del", 3000, "canceled"))));
    expect(dbRef.current.customers.get("org-1")!.status).toBe("canceled");

    // A late 'active' update with an EARLIER created (2000) arrives afterwards.
    const res = await POST(
      signedReq(rawOf(subEvent("customer.subscription.updated", "evt_late", 2000, "active")))
    );
    expect(res.status).toBe(200); // acknowledged...
    expect(dbRef.current.customers.get("org-1")!.status).toBe("canceled"); // ...but ignored
  });

  it("500s a payment_failed for a customer with no mirror row yet, without recording it (Stripe retries)", async () => {
    const invoiceEarly = {
      id: "evt_inv_early",
      created: 3000,
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_unknown", subscription: "sub_x" } },
    };
    const res = await POST(signedReq(rawOf(invoiceEarly)));
    expect(res.status).toBe(500);
    expect(dbRef.current.events.has("evt_inv_early")).toBe(false);
  });

  it("400s a checkout event missing identifiers, without recording it", async () => {
    const bad = {
      id: "evt_bad",
      type: "checkout.session.completed",
      data: { object: { client_reference_id: null, customer: "cus_1" } },
    };
    const res = await POST(signedReq(rawOf(bad)));
    expect(res.status).toBe(400);
    expect(dbRef.current.events.has("evt_bad")).toBe(false);
  });

  it("acknowledges unrelated event types without a mirror write", async () => {
    const res = await POST(
      signedReq(rawOf({ id: "evt_other", type: "invoice.paid", data: { object: {} } }))
    );
    expect(res.status).toBe(200);
    expect(dbRef.current.customers.size).toBe(0);
    expect(dbRef.current.events.has("evt_other")).toBe(true);
  });

  it("logs and proceeds when the idempotency check errors (fail-open; downstream writes are idempotent)", async () => {
    dbRef.current.forceSeenError = true;
    const res = await POST(signedReq(rawOf(checkoutEvent())));
    expect(res.status).toBe(200);
    expect(dbRef.current.customers.get("org-1")!.stripe_customer_id).toBe("cus_1");
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("idempotency check failed"),
      expect.objectContaining({ event: "stripe.webhook_idempotency_check_failed" })
    );
  });

  it("500s when the mirror row lookup errors", async () => {
    dbRef.current.forceCustomersSelectError = true;
    const res = await POST(signedReq(rawOf(checkoutEvent())));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Mirror lookup failed");
    expect(dbRef.current.customers.size).toBe(0);
  });

  it("holds the managed-payment block when a different invoice than the one that failed gets paid", async () => {
    await POST(signedReq(rawOf(checkoutEvent())));
    await POST(signedReq(rawOf(managedFailedEvent("evt_mf1", 2500, "in_original"))));
    expect(dbRef.current.customers.get("org-1")!.managed_failed_invoice_id).toBe(
      "in_original"
    );
    expect(dbRef.current.customers.get("org-1")!.managed_payment_failed_at).toBeTruthy();

    const res = await POST(
      signedReq(rawOf(managedPaidEvent("evt_mp1", 2600, "in_other")))
    );
    expect(res.status).toBe(200);
    // Still blocked — the paid invoice isn't the one that set the block.
    expect(dbRef.current.customers.get("org-1")!.managed_payment_failed_at).toBeTruthy();
  });

  it("clears the managed-payment block when the SAME failed invoice is later paid", async () => {
    await POST(signedReq(rawOf(checkoutEvent())));
    await POST(signedReq(rawOf(managedFailedEvent("evt_mf2", 2500, "in_same"))));
    expect(dbRef.current.customers.get("org-1")!.managed_payment_failed_at).toBeTruthy();

    const res = await POST(signedReq(rawOf(managedPaidEvent("evt_mp2", 2600, "in_same"))));
    expect(res.status).toBe(200);
    expect(dbRef.current.customers.get("org-1")!.managed_payment_failed_at).toBeNull();
  });

  it("notifies contributors on a managed-token invoice decline", async () => {
    await POST(signedReq(rawOf(checkoutEvent())));
    const res = await POST(signedReq(rawOf(managedFailedEvent("evt_mf3", 2500, "in_3"))));
    expect(res.status).toBe(200);
    expect(mockNotifyManagedPaymentFailed).toHaveBeenCalledWith(
      "org-1",
      5, // amount_due 500 cents
      expect.any(String)
    );
  });

  it("refuses a subscription event whose org is already bound to a different Stripe customer", async () => {
    await POST(signedReq(rawOf(checkoutEvent()))); // org-1 <-> cus_1
    const hijack = {
      id: "evt_hijack",
      created: 2000,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_x",
          customer: "cus_HIJACK",
          status: "active",
          metadata: { org_id: "org-1" },
          current_period_start: 1_700_000_000,
          current_period_end: 1_702_592_000,
          items: { data: [{ price: { id: "price_builder" } }] },
        },
      },
    };
    const res = await POST(signedReq(rawOf(hijack)));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Customer/org mismatch");
    expect(dbRef.current.customers.get("org-1")!.stripe_customer_id).toBe("cus_1");
  });

  it("500s when the customer mirror upsert write fails", async () => {
    dbRef.current.forceMirrorWriteError = true;
    const res = await POST(signedReq(rawOf(checkoutEvent())));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Database error");
  });

  it("500s when the customer mirror update write fails", async () => {
    await POST(signedReq(rawOf(checkoutEvent())));
    dbRef.current.forceMirrorWriteError = true;
    const invoiceFailed = {
      id: "evt_inv_upd_fail",
      created: 3000,
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_1", subscription: "sub_1" } },
    };
    const res = await POST(signedReq(rawOf(invoiceFailed)));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Database error");
  });

  describe("plan-change side effects (retention + grant reconciliation)", () => {
    it("applies retention and reconciles plan grants on a mid-period upgrade", async () => {
      vi.stubEnv("STRIPE_PRICE_BUILDER", "price_builder");
      vi.stubEnv("STRIPE_PRICE_SCALE", "price_scale");
      try {
        await POST(signedReq(rawOf(subUpdatedEvent("evt_sub_builder", 2000))));
        expect(dbRef.current.customers.get("org-1")!.stripe_price_id).toBe(
          "price_builder"
        );
        expect(mockApplyRetention).not.toHaveBeenCalled(); // no prior plan yet

        const res = await POST(
          signedReq(
            rawOf(
              subEvent(
                "customer.subscription.updated",
                "evt_sub_scale",
                3000,
                "active",
                "price_scale"
              )
            )
          )
        );
        expect(res.status).toBe(200);
        expect(mockApplyRetention).toHaveBeenCalledWith(
          "org-1",
          "builder",
          "scale",
          expect.any(String)
        );
        expect(
          dbRef.current.rpcCalls.some(
            (c) =>
              c.name === "reconcile_plan_grants" &&
              (c.args as { p_org_id: string }).p_org_id === "org-1"
          )
        ).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("500s when plan grant reconciliation fails", async () => {
      vi.stubEnv("STRIPE_PRICE_BUILDER", "price_builder");
      try {
        dbRef.current.forceRpcError = true;
        const res = await POST(signedReq(rawOf(subUpdatedEvent())));
        expect(res.status).toBe(500);
        expect(await res.text()).toBe("Database error");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("seat-cap violation email on subscription end", () => {
    it("emails contributors when an ended subscription leaves the Team over the Free seat cap", async () => {
      mockCountMembers.mockResolvedValue(5);
      const res = await POST(
        signedReq(rawOf(subEvent("customer.subscription.deleted", "evt_del_cap", 2000, "canceled")))
      );
      expect(res.status).toBe(200);
      expect(mockNotifyLimitOnce).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org-1", kind: "seat_cap_violation" })
      );
    });

    it("does not email when membership is within the Free seat cap", async () => {
      mockCountMembers.mockResolvedValue(1);
      await POST(
        signedReq(rawOf(subEvent("customer.subscription.deleted", "evt_del_ok", 2000, "canceled")))
      );
      expect(mockNotifyLimitOnce).not.toHaveBeenCalled();
    });
  });

  describe("invoice.created overage backstop", () => {
    it("syncs overage invoice items for a subscription-cycle invoice on a known org", async () => {
      await POST(signedReq(rawOf(checkoutEvent())));
      const res = await POST(signedReq(rawOf(invoiceCreatedEvent())));
      expect(res.status).toBe(200);
      expect(mockSyncOverageInvoiceItems).toHaveBeenCalledWith("org-1", {
        invoiceId: "in_cycle",
        invoiceCreatedAt: 4000,
      });
    });

    it("skips overage sync for a non subscription-cycle invoice.created", async () => {
      await POST(signedReq(rawOf(checkoutEvent())));
      const res = await POST(
        signedReq(rawOf(invoiceCreatedEvent("evt_ic_manual", 4000, "manual")))
      );
      expect(res.status).toBe(200);
      expect(mockSyncOverageInvoiceItems).not.toHaveBeenCalled();
    });

    it("logs and continues (200) when the invoice.created customer lookup errors", async () => {
      dbRef.current.forceCustomersSelectError = true;
      const res = await POST(signedReq(rawOf(invoiceCreatedEvent())));
      expect(res.status).toBe(200);
      expect(mockSyncOverageInvoiceItems).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("overage sync skipped"),
        expect.objectContaining({ event: "stripe.overage_sync_customer_lookup_failed" })
      );
    });
  });

  it("logs when the billing_events ledger write fails (non-duplicate error), but still acknowledges the webhook", async () => {
    dbRef.current.forceLedgerInsertError = { code: "other" };
    const res = await POST(signedReq(rawOf(checkoutEvent())));
    expect(res.status).toBe(200);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("ledger write failed"),
      expect.objectContaining({ event: "stripe.billing_event_ledger_failed" })
    );
  });
});
