import { describe, it, expect, vi, beforeEach } from "vitest";
import Stripe from "stripe";

// Real signature verification: set the secrets BEFORE @/lib/stripe is imported
// (vi.hoisted runs before module evaluation). We deliberately do NOT mock
// @/lib/stripe or @/lib/billing/webhook — this exercises the genuine Stripe HMAC
// path and the real event→mirror mapping. Only the DB and observability are faked.
const { dbRef } = vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY ??= "sk_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
  return { dbRef: { current: null as unknown as FakeDb } };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/analytics/server", () => ({ track: vi.fn() }));
vi.mock("@/lib/logging/server", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: (t: string) => dbRef.current.from(t) },
}));

import { POST } from "../route";

const SECRET = "whsec_test_secret";
const signer = new Stripe("sk_test_dummy");

interface CustomerRow {
  org_id?: string;
  stripe_customer_id?: string;
  stripe_subscription_id?: string | null;
  status?: string;
  stripe_price_id?: string | null;
  [k: string]: unknown;
}

// Faithful enough in-memory stand-in for the two tables the route touches (the
// vitest job has no live Postgres). Models the customers PK (org_id) and the
// billing_events unique id, so dedupe and "no duplicate rows" are real here.
class FakeDb {
  customers = new Map<string, CustomerRow>();
  events = new Set<string>();

  from(table: string) {
    if (table === "billing_events") {
      return {
        select: () => ({
          eq: (_c: string, id: string) => ({
            maybeSingle: async () => ({
              data: this.events.has(id) ? { stripe_event_id: id } : null,
            }),
          }),
        }),
        insert: async (row: { stripe_event_id: string }) => {
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
          maybeSingle: async () => ({ data: find(col, val) }),
        }),
      }),
      upsert: async (patch: CustomerRow) => {
        const prev = this.customers.get(patch.org_id!) ?? {};
        this.customers.set(patch.org_id!, { ...prev, ...patch });
        return { error: null };
      },
      update: (patch: CustomerRow) => ({
        eq: async (_col: string, custId: string) => {
          for (const [k, v] of this.customers) {
            if (v.stripe_customer_id === custId)
              this.customers.set(k, { ...v, ...patch });
          }
          return { error: null };
        },
      }),
    };
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
  status = "active"
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
      items: { data: [{ price: { id: "price_builder" } }] },
    },
  },
});

const subUpdatedEvent = (id = "evt_sub", created = 2000) =>
  subEvent("customer.subscription.updated", id, created, "active");

beforeEach(() => {
  dbRef.current = new FakeDb();
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
});
