import type Stripe from "stripe";

/**
 * Pure mapping from a verified Stripe event to a mirror mutation. Kept free of
 * I/O so the event→mirror contract (ADR-0008) is unit-testable without Stripe,
 * a database, or the route. The route (api/webhooks/stripe/route.ts) verifies
 * the signature, dedupes the event, then executes the action this returns.
 *
 * Two mutation shapes, because not every event knows the Team:
 *  - `upsert` keyed by org_id — used when the event carries the Team (checkout's
 *    client_reference_id, or subscription metadata), so it can create the row.
 *  - `update_by_customer` keyed by the Stripe customer id — used when it doesn't
 *    (invoice events), updating a row checkout/subscription already created.
 */

export interface CustomerMirror {
  org_id?: string;
  stripe_customer_id?: string;
  stripe_subscription_id?: string | null;
  status?: string;
  stripe_price_id?: string | null;
  current_period_start?: string | null;
  current_period_end?: string | null;
  email?: string | null;
  /** Cancellation scheduled for period end (#182) — reversible until then. */
  cancel_at_period_end?: boolean;
  /** A scheduled paid→paid downgrade (#182): the price taking over, and when. */
  pending_price_id?: string | null;
  pending_change_at?: string | null;
  stripe_schedule_id?: string | null;
}

export type MirrorAction =
  | { kind: "upsert"; orgId: string; patch: CustomerMirror }
  | { kind: "update_by_customer"; customerId: string; patch: CustomerMirror }
  | { kind: "noop" }
  | { kind: "invalid"; reason: string };

function idOf(
  ref: string | { id: string } | null | undefined
): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

function isoFromUnix(seconds: number | null | undefined): string | null {
  return typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null;
}

/**
 * Period bounds moved from the Subscription to its items across Stripe API
 * versions, so read either location. Typed loosely on purpose — the shape
 * differs by version and we only need the two timestamps.
 */
function periodBounds(sub: Stripe.Subscription): {
  start: string | null;
  end: string | null;
} {
  const s = sub as unknown as {
    current_period_start?: number;
    current_period_end?: number;
    items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
  };
  const item = s.items?.data?.[0];
  return {
    start: isoFromUnix(s.current_period_start ?? item?.current_period_start),
    end: isoFromUnix(s.current_period_end ?? item?.current_period_end),
  };
}

function subscriptionPatch(sub: Stripe.Subscription): CustomerMirror {
  const { start, end } = periodBounds(sub);
  return {
    stripe_customer_id: idOf(sub.customer) ?? undefined,
    stripe_subscription_id: sub.id,
    status: sub.status,
    stripe_price_id: sub.items?.data?.[0]?.price?.id ?? null,
    current_period_start: start,
    current_period_end: end,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
  };
}

/**
 * A subscription schedule mirrors as a pending plan change only while the
 * change is still AHEAD: the schedule is live and the current phase is not
 * the final one. At the boundary, Stripe's phase-transition `updated` event
 * reports current_phase = the final phase — the pending display clears, but
 * stripe_schedule_id stays: the schedule keeps owning the subscription until
 * it releases (up to one more cycle), and the plan-change actions need the id
 * to release it. A snapshot that says nothing about pending state — a 1-phase
 * schedule, or a non-live one — returns null (noop): clearing those is the
 * release/cancel lifecycle events' job, and a clear here would let the
 * 1-phase `created` event wipe the 2-phase `updated` patch when Stripe
 * delivers them out of order. Typed loosely — only the ids and the boundary
 * timestamp are needed.
 */
function schedulePatch(schedule: Stripe.SubscriptionSchedule): CustomerMirror | null {
  const phases = (schedule.phases ?? []) as Array<{
    start_date?: number;
    items?: Array<{ price?: string | { id: string } }>;
  }>;
  const live = schedule.status === "active" || schedule.status === "not_started";
  const next = live && phases.length > 1 ? phases[phases.length - 1] : null;
  const nextPrice = next ? idOf(next.items?.[0]?.price ?? null) : null;
  if (!next || !nextPrice) {
    return null;
  }
  const executed =
    next.start_date != null &&
    schedule.current_phase?.start_date != null &&
    schedule.current_phase.start_date >= next.start_date;
  if (executed) {
    return {
      pending_price_id: null,
      pending_change_at: null,
      stripe_schedule_id: schedule.id,
    };
  }
  return {
    pending_price_id: nextPrice,
    pending_change_at: isoFromUnix(next.start_date),
    stripe_schedule_id: schedule.id,
  };
}

export function mirrorActionForEvent(event: Stripe.Event): MirrorAction {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      // client_reference_id is the Team (org) id, set by checkout.ts.
      const orgId = session.client_reference_id;
      const customerId = idOf(session.customer);
      if (!orgId || !customerId) {
        return { kind: "invalid", reason: "missing org or customer id" };
      }
      return {
        kind: "upsert",
        orgId,
        patch: {
          org_id: orgId,
          stripe_customer_id: customerId,
          stripe_subscription_id: idOf(session.subscription),
          email: session.customer_email,
        },
      };
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const patch = subscriptionPatch(sub);
      // org_id rides on subscription metadata (set at checkout) so these events
      // can create/repair the row regardless of delivery order. Without it we
      // can only update an existing row by customer id.
      const orgId = sub.metadata?.org_id;
      const customerId = patch.stripe_customer_id;
      if (orgId) {
        return { kind: "upsert", orgId, patch: { ...patch, org_id: orgId } };
      }
      if (customerId) {
        return { kind: "update_by_customer", customerId, patch };
      }
      return { kind: "invalid", reason: "subscription missing org and customer" };
    }

    case "subscription_schedule.created":
    case "subscription_schedule.updated": {
      const schedule = event.data.object as Stripe.SubscriptionSchedule;
      const customerId = idOf(schedule.customer);
      if (!customerId) {
        return { kind: "invalid", reason: "schedule missing customer id" };
      }
      const patch = schedulePatch(schedule);
      // No pending change in this snapshot → nothing to assert. Deliberately
      // NOT a clear: clears come from the lifecycle events below, so an
      // out-of-order 1-phase `created` can't wipe live pending state.
      if (!patch) return { kind: "noop" };
      return { kind: "update_by_customer", customerId, patch };
    }

    case "subscription_schedule.released":
    case "subscription_schedule.canceled":
    case "subscription_schedule.aborted":
    case "subscription_schedule.completed": {
      // The schedule no longer governs the subscription — clear the pending
      // change. (On completion the phase boundary also fires a
      // customer.subscription.updated that rolls the actual price.)
      const schedule = event.data.object as Stripe.SubscriptionSchedule;
      const customerId = idOf(schedule.customer);
      if (!customerId) {
        return { kind: "invalid", reason: "schedule missing customer id" };
      }
      return {
        kind: "update_by_customer",
        customerId,
        patch: { pending_price_id: null, pending_change_at: null, stripe_schedule_id: null },
      };
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = idOf(invoice.customer);
      if (!customerId) {
        return { kind: "invalid", reason: "invoice missing customer id" };
      }
      // A failed payment flips the mirror to past_due, which the resolver treats
      // as blocked. The row already exists (checkout created it).
      return {
        kind: "update_by_customer",
        customerId,
        patch: { status: "past_due" },
      };
    }

    default:
      // Acknowledged without state change (idempotency ledger still records it).
      return { kind: "noop" };
  }
}
