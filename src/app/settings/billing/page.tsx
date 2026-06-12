import Link from "next/link";
import { getAuthContext } from "@/lib/auth/context";
import { NavBar } from "@/app/_components/nav-bar";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getPointBudget, listLedgerEntries, type LedgerEntry } from "@/lib/billing/ledger";
import { getOptimizationAllowance } from "@/lib/billing/allowance";
import { getOverageState, hasDirtyOverageLines } from "@/lib/billing/overage";
import { syncOverageInvoiceItems } from "@/lib/billing/overage-sync";
import { getBillingState, isEndedStatus } from "@/lib/billing/state";
import { countMembers } from "@/lib/billing/seats";
import { PLANS, planForPriceId, isPaidPlanSlug } from "@/lib/billing/plans";
import { evalRunPointsPerRow } from "@/lib/billing/points";
import { openBillingPortal } from "@/app/actions/billing-portal";
import { pillBtnCls } from "@/app/_components/form-styles";
import { PlanActions } from "./_components/plan-actions";
import { OverageCap } from "./_components/overage-cap";

/**
 * Team billing page — the hub (#191): current Plan, subscription status,
 * plan changes & Cancellation (#182), "Manage billing" via the restricted
 * Stripe Customer Portal, plus the Eval Point balance and Point Ledger from
 * #180. Contributor-only, same gate as Team settings. The full usage meters
 * arrive with S13 (#192).
 */
export default async function BillingSettingsPage() {
  const { canWrite, orgId } = await getAuthContext();
  if (!canWrite || !orgId) {
    redirect("/rubrics");
  }

  const [billing, budget, { data: customer }, memberCount] = await Promise.all([
    getBillingState(orgId),
    getPointBudget(orgId),
    // The portal precondition is the Stripe customer itself — checked directly,
    // not inferred from status: a checkout.session.completed upsert creates the
    // row before the subscription event fills the status in.
    supabaseAdmin
      .from("customers")
      .select("stripe_customer_id")
      .eq("org_id", orgId)
      .maybeSingle(),
    countMembers(orgId),
  ]);
  const [entries, allowance] = await Promise.all([
    listLedgerEntries(orgId, budget.periodStart),
    getOptimizationAllowance(orgId),
  ]);
  // Overage posture (#183): negative balances are committed overage. The
  // rates come from the quota tier, so a floored (past_due/free) Team shows
  // no overage card at all.
  const overage = await getOverageState(orgId, {
    pointBalance: budget.balance,
    runBalance: allowance.remaining,
    plan: budget.plan,
  });
  // Opportunistic Stripe push: settled overage the worker recorded gets
  // invoiced the next time anyone looks at billing. Deliberately NOT awaited —
  // a slow Stripe must never stall this page, and the invoice.created webhook
  // is the period-end backstop that makes the push guaranteed.
  if (overage.rates && (await hasDirtyOverageLines(orgId))) {
    void syncOverageInvoiceItems(orgId);
  }
  // The quota tier in force — what the Eval Points card meters against.
  const plan = PLANS[budget.plan];
  // The plan card names the SUBSCRIBED plan from the mirrored price id while
  // the subscription EXISTS — even out of good standing: a past_due/unpaid
  // Builder Team is still "Builder" with a status chip, not silently "Free"
  // (Kevin, 2026-06-12; only the quota tier floors). An ENDED subscription is
  // no longer subscribed: the card floors.
  const subscribed = billing.status != null && !isEndedStatus(billing.status);
  const cardPlan =
    PLANS[subscribed ? planForPriceId(billing.priceId) ?? budget.plan : budget.plan];
  // The two live payment-failure states get the chip and the recovery banner.
  const paymentFailed = billing.status === "past_due" || billing.status === "unpaid";
  const hasBillingAccount = Boolean(customer?.stripe_customer_id);

  // Pinned to UTC: dates come from the Stripe mirror in UTC, and the rendered
  // day must not depend on whichever timezone the server happens to run in.
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  const resetDate = fmtDate(budget.periodEnd);
  const renewalDate = billing.currentPeriodEnd ? fmtDate(billing.currentPeriodEnd) : null;
  const fmt = (n: number) => n.toLocaleString("en-US");

  // Scheduled changes (#182): a Cancellation or a paid→paid downgrade renders
  // as a pending line ("Scale until <date>, then Builder") with the undo —
  // only while the subscription still exists (an executed cancellation keeps
  // cancel_at_period_end on the mirror, but there's nothing pending anymore).
  // One object so kind, target, and date can never disagree.
  const subscribedPlan = planForPriceId(billing.priceId);
  const pendingChange = !subscribed
    ? null
    : billing.cancelAtPeriodEnd
      ? { kind: "cancel" as const, target: "Free", date: renewalDate }
      : billing.pendingPriceId
        ? {
            kind: "downgrade" as const,
            target: PLANS[planForPriceId(billing.pendingPriceId) ?? "free"].name,
            date: billing.pendingChangeAt ? fmtDate(billing.pendingChangeAt) : renewalDate,
          }
        : null;

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <NavBar />
      <main className="mx-auto w-full max-w-2xl flex-1 p-6">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">Billing</h1>
        <p className="mt-1 text-sm text-fg-2">
          Your team&apos;s plan, billing details, and usage for the current
          billing period.
        </p>

        <section
          data-testid="plan-card"
          className="mt-6 rounded-2xl border border-hairline-cool bg-card p-6 shadow-card"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-medium text-fg-2">Current plan</h2>
              <p className="mt-1 flex items-center gap-2.5 text-2xl font-semibold tracking-[-0.01em] text-ink">
                {cardPlan.name}
                <span className="text-sm font-normal text-fg-3">
                  ${cardPlan.monthlyPriceUsd}/mo
                </span>
                {paymentFailed && (
                  <span
                    data-testid="plan-status-chip"
                    className="rounded-full border border-danger px-2.5 py-0.5 text-xs font-medium text-danger-fg"
                  >
                    Payment failed
                  </span>
                )}
              </p>
              <p className="mt-1 text-sm text-fg-2" data-testid="plan-subline">
                {pendingChange
                  ? `${cardPlan.name} until ${pendingChange.date}, then ${pendingChange.target}`
                  : billing.active && renewalDate
                    ? `Renews ${renewalDate}`
                    : paymentFailed
                      ? "Paid features are paused until the payment goes through."
                      : hasBillingAccount
                        ? "No active subscription"
                        : "Your team is on the free plan."}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              {hasBillingAccount ? (
                <form action={openBillingPortal}>
                  <button type="submit" className={pillBtnCls}>
                    Manage billing
                  </button>
                </form>
              ) : (
                <Link href="/pricing" className={pillBtnCls}>
                  Compare plans →
                </Link>
              )}
              {/* Plan changes are offered while the subscription exists — a
                  past_due/unpaid Team must still be able to cancel, or revert
                  a scheduled change; upgrades need good standing. */}
              {subscribed && isPaidPlanSlug(subscribedPlan) && (
                <PlanActions
                  plan={subscribedPlan}
                  periodEndLabel={renewalDate}
                  pending={pendingChange?.kind ?? null}
                  memberCount={memberCount}
                  upgradeAllowed={billing.active}
                />
              )}
            </div>
          </div>
          {paymentFailed && (
            <p
              data-testid="payment-failed-banner"
              className="mt-4 rounded-lg border border-danger bg-card px-4 py-3 text-sm text-danger-fg"
            >
              Your last payment failed, so your team is limited to the Free
              quota for now. Use <strong>Manage billing</strong> to update your
              payment method — your plan resumes as soon as the payment goes
              through.
            </p>
          )}
        </section>

        <section className="mt-6 rounded-2xl border border-hairline-cool bg-card p-6 shadow-card">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-medium text-ink">Eval Points</h2>
            <span className="text-xs text-fg-3">resets {resetDate}</span>
          </div>
          <p className="mt-3 text-2xl font-semibold tabular-nums tracking-[-0.01em] text-ink" data-testid="point-balance">
            {fmt(Math.max(0, budget.balance))}
            <span className="ml-1.5 text-sm font-normal text-fg-3">
              of {fmt(budget.included)} remaining
            </span>
          </p>
          {/* The real block condition is per-run (cost > balance); below the
              cheapest possible run (1 row × 1 criterion) every run is refused,
              so that is the honest "effectively exhausted" line — unless a
              cap with headroom keeps runs going (#183). */}
          {budget.balance < evalRunPointsPerRow(1) &&
            !(overage.capUsd != null && overage.committedUsd < overage.capUsd) && (
              <p className="mt-2 text-sm text-danger-fg" data-testid="points-exhausted">
                Your team doesn&apos;t have enough Eval Points left to start new
                runs. Points reset when the period does{plan.slug === "free" ? " — or sooner on a larger plan" : ""}.
              </p>
            )}
        </section>

        {overage.rates && (
          <OverageCap
            capUsd={overage.capUsd}
            committedUsd={overage.committedUsd}
            pointsOver={overage.pointsOver}
            runsOver={overage.runsOver}
            pointUnitUsd={overage.rates.pointUnitUsd}
            runUnitUsd={overage.rates.runUnitUsd}
          />
        )}

        <section className="mt-6">
          <h2 className="text-sm font-medium text-ink">Point Ledger</h2>
          <p className="mt-1 text-xs text-fg-3">
            Every Eval Point movement this period. The balance above is always
            the sum of these entries.
          </p>
          {entries.length === 0 ? (
            <p className="mt-3 text-sm text-fg-2">No activity yet this period.</p>
          ) : (
            <ul
              data-testid="point-ledger"
              className="mt-3 flex flex-col divide-y divide-hairline-cool rounded-2xl border border-hairline-cool bg-card"
            >
              {entries.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm text-ink">{entryLabel(e)}</p>
                    <p className="mt-0.5 text-xs text-fg-3">
                      {new Date(e.createdAt).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      {e.evalRunId && <> · run {e.evalRunId.slice(0, 8)}</>}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 font-mono text-sm font-semibold tabular-nums ${entryTone(e)}`}
                  >
                    {entryAmount(e)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

/**
 * One row per entry type so label, sign, and tone can never disagree. Signed
 * display follows the balance math: grant/release add, reserve subtracts,
 * settle is balance-neutral (the reservation already paid).
 */
const ENTRY_DISPLAY: Record<
  LedgerEntry["entryType"],
  { label: string; sign: "+" | "−" | ""; tone: string }
> = {
  grant: { label: "Period grant", sign: "+", tone: "text-success-fg" },
  upgrade: { label: "Upgrade grant — plan change", sign: "+", tone: "text-success-fg" },
  reserve: { label: "Reserved for eval run", sign: "−", tone: "text-danger-fg" },
  settle: { label: "Settled — points consumed", sign: "", tone: "text-fg-3" },
  release: { label: "Released back — unused reservation", sign: "+", tone: "text-success-fg" },
};

function entryLabel(e: LedgerEntry): string {
  return ENTRY_DISPLAY[e.entryType].label;
}

function entryAmount(e: LedgerEntry): string {
  const d = ENTRY_DISPLAY[e.entryType];
  return `${d.sign}${e.points.toLocaleString("en-US")}`;
}

function entryTone(e: LedgerEntry): string {
  return ENTRY_DISPLAY[e.entryType].tone;
}
