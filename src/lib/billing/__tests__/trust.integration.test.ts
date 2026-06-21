import { describe, it, expect, beforeAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
// billing-managed-spend pulls the analytics + cache seams at import; stub the
// side-effecting ones so the action runs against the real DB only.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/analytics/server", () => ({ track: vi.fn() }));

// setManagedSpendCap resolves the caller via getAuthContext; pin it to the org
// under test so the real raise path (ceiling check + write) is exercised.
const auth = vi.hoisted(() => ({
  ctx: { userId: "", orgId: "", canWrite: true, role: "admin" as const },
}));
vi.mock("@/lib/auth/context", () => ({
  getAuthContext: vi.fn(async () => auth.ctx),
}));

/**
 * Integration tests for trust escalation (#188, ADR-0008). The trust ceiling, its
 * derivation from the paid_invoices mirror, the raise enforcement, cross-Team
 * isolation, and the webhook record/reverse paths all touch Postgres, so they run
 * against the real local DB. Skipped without local Supabase env:
 *
 *   set -a; source .env.local; set +a; npx vitest run trust.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const priceBuilder = process.env.STRIPE_PRICE_BUILDER;
const hasDb = Boolean(url && serviceKey && priceBuilder);

describe.skipIf(!hasDb)("trust escalation (integration)", () => {
  let db: SupabaseClient;

  beforeAll(() => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });
  });

  /** A fresh active-Builder Team with a Stripe customer mirror row. */
  async function newBuilderTeam(): Promise<{
    orgId: string;
    userId: string;
    customerId: string;
  }> {
    const { data: org, error: orgErr } = await db
      .from("organizations")
      .insert({ name: `trust-${crypto.randomUUID()}` })
      .select("id")
      .single();
    if (orgErr) throw new Error(orgErr.message);
    const { data: authUser, error: authErr } = await db.auth.admin.createUser({
      email: `trust-${crypto.randomUUID()}@example.com`,
      password: crypto.randomUUID(),
      email_confirm: true,
    });
    if (authErr) throw new Error(authErr.message);
    await db.from("users").upsert({ id: authUser.user.id }, { onConflict: "id" });
    const customerId = `cus_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const { error: custErr } = await db.from("customers").insert({
      org_id: org.id,
      stripe_customer_id: customerId,
      status: "active",
      stripe_price_id: priceBuilder,
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    if (custErr) throw new Error(custErr.message);
    return { orgId: org.id as string, userId: authUser.user.id, customerId };
  }

  /** Seed N paid invoices for a Team, `reversed` of them already reversed. */
  async function seedInvoices(
    orgId: string,
    live: number,
    reversed = 0,
  ): Promise<void> {
    const rows = [];
    for (let i = 0; i < live + reversed; i++) {
      rows.push({
        stripe_invoice_id: `in_${crypto.randomUUID()}`,
        org_id: orgId,
        paid_at: new Date().toISOString(),
        amount_usd: 49,
        reversed_at: i < reversed ? new Date().toISOString() : null,
        reversal_reason: i < reversed ? "dispute" : null,
      });
    }
    const { error } = await db.from("paid_invoices").insert(rows);
    if (error) throw new Error(error.message);
  }

  const paidEvent = (
    customerId: string,
    invoiceId: string,
    piId: string | null,
    amountCents = 4900,
  ) =>
    ({
      id: `evt_${invoiceId}`,
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: invoiceId,
          customer: customerId,
          amount_paid: amountCents,
          payments: piId
            ? { data: [{ payment: { payment_intent: piId } }] }
            : undefined,
        },
      },
    }) as never;

  it("counts only un-reversed invoices, isolated per Team", async () => {
    const { getPaidInvoiceCount, getTrustStatus } = await import("@/lib/billing/trust");
    const a = await newBuilderTeam();
    const b = await newBuilderTeam();
    await seedInvoices(a.orgId, 2, 1); // 2 live + 1 reversed
    await seedInvoices(b.orgId, 5, 0);

    expect(await getPaidInvoiceCount(a.orgId)).toBe(2);
    expect(await getPaidInvoiceCount(b.orgId)).toBe(5);

    // Builder default $25: 2 invoices → ×2 = $50; B's 5 invoices never leak in.
    const sa = await getTrustStatus(a.orgId);
    expect(sa.plan).toBe("builder");
    expect(sa.ceilingUsd).toBe(50);
    expect(sa.paidInvoices).toBe(2);
    expect(sa.nextTier).toEqual({ atPaidInvoices: 4, ceilingUsd: 100 });

    const sb = await getTrustStatus(b.orgId);
    expect(sb.ceilingUsd).toBe(100); // 5 invoices → ×4
  });

  it("blocks a raise above the ceiling, allows at/below it", async () => {
    const { setManagedSpendCap } = await import("@/app/actions/billing-managed-spend");
    const team = await newBuilderTeam();
    await seedInvoices(team.orgId, 2); // ceiling = $50
    auth.ctx = { userId: team.userId, orgId: team.orgId, canWrite: true, role: "admin" };

    const set = (cap: number) => {
      const fd = new FormData();
      fd.set("capUsd", String(cap));
      return setManagedSpendCap(fd);
    };

    expect(await set(40)).toEqual({ ok: true }); // below
    expect(await set(50)).toEqual({ ok: true }); // at the ceiling
    const above = await set(51);
    expect(above).toHaveProperty("error");
    expect((above as { error: string }).error).toMatch(/ceiling/i);
    expect(await set(1000)).toHaveProperty("error");

    // The last successful write ($50) is what's persisted — the blocked ones didn't.
    const { data } = await db
      .from("billing_settings")
      .select("managed_spend_cap_usd")
      .eq("org_id", team.orgId)
      .single();
    expect(Number(data!.managed_spend_cap_usd)).toBe(50);
  });

  it("a brand-new Team cannot self-raise above the plan default", async () => {
    const { setManagedSpendCap } = await import("@/app/actions/billing-managed-spend");
    const team = await newBuilderTeam(); // 0 paid invoices → ceiling = $25 default
    auth.ctx = { userId: team.userId, orgId: team.orgId, canWrite: true, role: "admin" };

    const set = (cap: number) => {
      const fd = new FormData();
      fd.set("capUsd", String(cap));
      return setManagedSpendCap(fd);
    };

    expect(await set(26)).toHaveProperty("error"); // above default — refused
    expect(await set(25)).toEqual({ ok: true }); // at default
    expect(await set(10)).toEqual({ ok: true }); // lowering is always fine
  });

  it("records a paid invoice (advancing trust), idempotently", async () => {
    const { applyTrustWebhook, getPaidInvoiceCount } = await import("@/lib/billing/trust");
    const team = await newBuilderTeam();
    const invoiceId = `in_${crypto.randomUUID()}`;

    expect(await applyTrustWebhook(paidEvent(team.customerId, invoiceId, "pi_x1"))).toBe(true);
    expect(await getPaidInvoiceCount(team.orgId)).toBe(1);

    // Replay (Stripe at-least-once) must not double-count.
    await applyTrustWebhook(paidEvent(team.customerId, invoiceId, "pi_x1"));
    expect(await getPaidInvoiceCount(team.orgId)).toBe(1);
  });

  it("a dispute reverses the invoice it bought, dropping it from trust", async () => {
    const { applyTrustWebhook, getPaidInvoiceCount } = await import("@/lib/billing/trust");
    const team = await newBuilderTeam();
    const invoiceId = `in_${crypto.randomUUID()}`;
    await applyTrustWebhook(paidEvent(team.customerId, invoiceId, "pi_disp"));
    expect(await getPaidInvoiceCount(team.orgId)).toBe(1);

    const disputeEvent = {
      id: `evt_disp_${invoiceId}`,
      type: "charge.dispute.created",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "dp_1", payment_intent: "pi_disp", charge: "ch_1" } },
    } as never;
    expect(await applyTrustWebhook(disputeEvent)).toBe(true);
    expect(await getPaidInvoiceCount(team.orgId)).toBe(0); // trust withdrawn
  });

  it("a refund (by payment intent) and an uncollectible mark (by invoice) reverse", async () => {
    const { applyTrustWebhook, getPaidInvoiceCount } = await import("@/lib/billing/trust");
    const team = await newBuilderTeam();
    const refunded = `in_${crypto.randomUUID()}`;
    const written = `in_${crypto.randomUUID()}`;
    await applyTrustWebhook(paidEvent(team.customerId, refunded, "pi_ref"));
    await applyTrustWebhook(paidEvent(team.customerId, written, "pi_unc"));
    expect(await getPaidInvoiceCount(team.orgId)).toBe(2);

    const refundEvent = {
      id: `evt_ref_${refunded}`,
      type: "charge.refunded",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "ch_ref", payment_intent: "pi_ref" } },
    } as never;
    const uncollectibleEvent = {
      id: `evt_unc_${written}`,
      type: "invoice.marked_uncollectible",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: written, customer: team.customerId } },
    } as never;
    await applyTrustWebhook(refundEvent);
    await applyTrustWebhook(uncollectibleEvent);
    expect(await getPaidInvoiceCount(team.orgId)).toBe(0);
  });
});
