import { describe, it, expect } from "vitest";
import type Stripe from "stripe";
import { mirrorActionForEvent } from "../webhook";

// Minimal event factories — only the fields the mapping reads.
function checkout(overrides: Record<string, unknown> = {}): Stripe.Event {
  return {
    id: "evt_co",
    type: "checkout.session.completed",
    data: {
      object: {
        client_reference_id: "org-1",
        customer: "cus_1",
        subscription: "sub_1",
        customer_email: "buyer@acme.com",
        ...overrides,
      },
    },
  } as unknown as Stripe.Event;
}

function subscription(
  type:
    | "customer.subscription.created"
    | "customer.subscription.updated"
    | "customer.subscription.deleted",
  overrides: Record<string, unknown> = {}
): Stripe.Event {
  return {
    id: "evt_sub",
    type,
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        status: type === "customer.subscription.deleted" ? "canceled" : "active",
        metadata: { org_id: "org-1" },
        current_period_start: 1_700_000_000,
        current_period_end: 1_702_592_000,
        items: { data: [{ price: { id: "price_builder" } }] },
        ...overrides,
      },
    },
  } as unknown as Stripe.Event;
}

describe("mirrorActionForEvent", () => {
  it("maps checkout.session.completed to an org-keyed upsert linking customer + subscription", () => {
    const action = mirrorActionForEvent(checkout());
    expect(action).toEqual({
      kind: "upsert",
      orgId: "org-1",
      patch: {
        org_id: "org-1",
        stripe_customer_id: "cus_1",
        stripe_subscription_id: "sub_1",
        email: "buyer@acme.com",
      },
    });
  });

  it("invalidates checkout missing the Team (client_reference_id)", () => {
    const action = mirrorActionForEvent(checkout({ client_reference_id: null }));
    expect(action.kind).toBe("invalid");
  });

  it("invalidates checkout missing the customer id", () => {
    const action = mirrorActionForEvent(checkout({ customer: null }));
    expect(action.kind).toBe("invalid");
  });

  it("maps subscription.updated to an org-keyed upsert with status, price and period", () => {
    const action = mirrorActionForEvent(subscription("customer.subscription.updated"));
    expect(action).toEqual({
      kind: "upsert",
      orgId: "org-1",
      patch: {
        org_id: "org-1",
        stripe_customer_id: "cus_1",
        stripe_subscription_id: "sub_1",
        status: "active",
        stripe_price_id: "price_builder",
        current_period_start: new Date(1_700_000_000 * 1000).toISOString(),
        current_period_end: new Date(1_702_592_000 * 1000).toISOString(),
        cancel_at_period_end: false,
      },
    });
  });

  it("reads period bounds from the subscription item when absent on the subscription", () => {
    const action = mirrorActionForEvent(
      subscription("customer.subscription.updated", {
        current_period_start: undefined,
        current_period_end: undefined,
        items: {
          data: [
            {
              price: { id: "price_builder" },
              current_period_start: 1_700_000_000,
              current_period_end: 1_702_592_000,
            },
          ],
        },
      })
    );
    expect(action.kind).toBe("upsert");
    if (action.kind === "upsert") {
      expect(action.patch.current_period_end).toBe(
        new Date(1_702_592_000 * 1000).toISOString()
      );
    }
  });

  it("falls back to update-by-customer when subscription metadata has no org_id", () => {
    const action = mirrorActionForEvent(
      subscription("customer.subscription.updated", { metadata: {} })
    );
    expect(action).toMatchObject({
      kind: "update_by_customer",
      customerId: "cus_1",
    });
  });

  it("maps subscription.deleted to a canceled status", () => {
    const action = mirrorActionForEvent(subscription("customer.subscription.deleted"));
    expect(action.kind).toBe("upsert");
    if (action.kind === "upsert") expect(action.patch.status).toBe("canceled");
  });

  it("maps invoice.payment_failed to a past_due update by customer", () => {
    const event = {
      id: "evt_inv",
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_1", subscription: "sub_1" } },
    } as unknown as Stripe.Event;
    expect(mirrorActionForEvent(event)).toEqual({
      kind: "update_by_customer",
      customerId: "cus_1",
      patch: { status: "past_due" },
    });
  });

  it("treats unrelated event types as a no-op", () => {
    const event = {
      id: "evt_x",
      type: "invoice.paid",
      data: { object: {} },
    } as unknown as Stripe.Event;
    expect(mirrorActionForEvent(event)).toEqual({ kind: "noop" });
  });

  // --- Scheduled changes (#182) ---

  it("mirrors cancel_at_period_end from subscription events", () => {
    const action = mirrorActionForEvent(
      subscription("customer.subscription.updated", { cancel_at_period_end: true })
    );
    expect(action.kind).toBe("upsert");
    if (action.kind === "upsert") {
      expect(action.patch.cancel_at_period_end).toBe(true);
    }
    const cleared = mirrorActionForEvent(subscription("customer.subscription.updated"));
    if (cleared.kind === "upsert") {
      expect(cleared.patch.cancel_at_period_end).toBe(false);
    }
  });

  function schedule(
    type: string,
    phases: Array<{ start_date: number; items: Array<{ price: string }> }>,
    opts: { status?: string; currentPhaseStart?: number } = {}
  ): Stripe.Event {
    return {
      id: "evt_sched",
      type,
      data: {
        object: {
          id: "sched_1",
          customer: "cus_1",
          status: opts.status ?? "active",
          current_phase: { start_date: opts.currentPhaseStart ?? phases[0]?.start_date },
          phases,
        },
      },
    } as unknown as Stripe.Event;
  }

  const TWO_PHASES = [
    { start_date: 1_700_000_000, items: [{ price: "price_scale" }] },
    { start_date: 1_702_592_000, items: [{ price: "price_builder" }] },
  ];

  it("mirrors a two-phase schedule as a pending plan change", () => {
    const action = mirrorActionForEvent(
      schedule("subscription_schedule.updated", TWO_PHASES)
    );
    expect(action).toEqual({
      kind: "update_by_customer",
      customerId: "cus_1",
      patch: {
        pending_price_id: "price_builder",
        pending_change_at: new Date(1_702_592_000 * 1000).toISOString(),
        stripe_schedule_id: "sched_1",
      },
    });
  });

  it("treats a single-phase schedule as a noop, never a clear", () => {
    // The 1-phase `created` snapshot precedes the 2-phase `updated` in the
    // downgrade flow; were it a clear, out-of-order delivery would wipe the
    // pending state the `updated` patch just mirrored.
    const action = mirrorActionForEvent(
      schedule("subscription_schedule.created", [TWO_PHASES[0]])
    );
    expect(action).toEqual({ kind: "noop" });
  });

  it("clears the pending display once the boundary passes, keeping the schedule id", () => {
    // Phase transition: current_phase is now the final phase. The change is
    // no longer pending, but the schedule still owns the subscription until
    // it releases — the actions need the id to release it.
    const action = mirrorActionForEvent(
      schedule("subscription_schedule.updated", TWO_PHASES, {
        currentPhaseStart: 1_702_592_000,
      })
    );
    expect(action).toEqual({
      kind: "update_by_customer",
      customerId: "cus_1",
      patch: {
        pending_price_id: null,
        pending_change_at: null,
        stripe_schedule_id: "sched_1",
      },
    });
  });

  it("ignores snapshots of non-live schedules (a late `updated` after release)", () => {
    const action = mirrorActionForEvent(
      schedule("subscription_schedule.updated", TWO_PHASES, { status: "released" })
    );
    expect(action).toEqual({ kind: "noop" });
  });

  it.each([
    "subscription_schedule.released",
    "subscription_schedule.canceled",
    "subscription_schedule.aborted",
    "subscription_schedule.completed",
  ])("clears the pending change when the schedule ends (%s)", (type) => {
    const action = mirrorActionForEvent(
      schedule(type, [
        { start_date: 1_700_000_000, items: [{ price: "price_scale" }] },
        { start_date: 1_702_592_000, items: [{ price: "price_builder" }] },
      ])
    );
    expect(action).toEqual({
      kind: "update_by_customer",
      customerId: "cus_1",
      patch: { pending_price_id: null, pending_change_at: null, stripe_schedule_id: null },
    });
  });
});
