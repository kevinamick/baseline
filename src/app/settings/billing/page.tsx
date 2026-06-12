import Link from "next/link";
import { getAuthContext } from "@/lib/auth/context";
import { NavBar } from "@/app/_components/nav-bar";
import { redirect } from "next/navigation";
import { getPointBudget, listLedgerEntries, type LedgerEntry } from "@/lib/billing/ledger";
import { getBillingState } from "@/lib/billing/state";
import { PLANS } from "@/lib/billing/plans";
import { evalRunPointsPerRow } from "@/lib/billing/points";
import { openBillingPortal } from "@/app/actions/billing-portal";

/**
 * Team billing page — the hub (#191): current Plan, subscription status, and
 * "Manage billing" via the restricted Stripe Customer Portal, plus the Eval
 * Point balance and Point Ledger from #180. Contributor-only, same gate as
 * Team settings. Cancellation/plan changes arrive with S5 (#182), the full
 * usage meters with S13 (#192).
 */
export default async function BillingSettingsPage() {
  const { canWrite, orgId } = await getAuthContext();
  if (!canWrite || !orgId) {
    redirect("/rubrics");
  }

  const [billing, budget] = await Promise.all([
    getBillingState(orgId),
    getPointBudget(orgId),
  ]);
  const entries = await listLedgerEntries(orgId, budget.periodStart);
  const plan = PLANS[budget.plan];
  // A mirror row (any status) means a Stripe customer exists — the portal can
  // always show that Team its invoices and payment method.
  const hasBillingAccount = billing.status !== null;

  const resetDate = new Date(budget.periodEnd).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const renewalDate = billing.currentPeriodEnd
    ? new Date(billing.currentPeriodEnd).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;
  const fmt = (n: number) => n.toLocaleString("en-US");

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
              <p className="mt-1 text-2xl font-semibold tracking-[-0.01em] text-ink">
                {plan.name}
                <span className="ml-2 text-sm font-normal text-fg-3">
                  {plan.monthlyPriceUsd > 0 ? `$${plan.monthlyPriceUsd}/mo` : "$0/mo"}
                </span>
              </p>
              <p className="mt-1 text-sm text-fg-2">
                {billing.active && renewalDate
                  ? `Renews ${renewalDate}`
                  : hasBillingAccount
                    ? "No active subscription"
                    : "Your team is on the free plan."}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              {hasBillingAccount ? (
                <form action={openBillingPortal}>
                  <button
                    type="submit"
                    className="rounded-full border border-hairline-field px-4 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-card-warm"
                  >
                    Manage billing
                  </button>
                </form>
              ) : (
                <Link
                  href="/pricing"
                  className="rounded-full border border-hairline-field px-4 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-card-warm"
                >
                  Compare plans →
                </Link>
              )}
            </div>
          </div>
          {billing.status === "past_due" && (
            <p
              data-testid="payment-failed-banner"
              className="mt-4 rounded-lg border border-danger bg-card px-4 py-3 text-sm text-danger-fg"
            >
              Your last payment failed and runs are paused. Use{" "}
              <strong>Manage billing</strong> to update your payment method —
              access returns as soon as the payment goes through.
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
              so that is the honest "effectively exhausted" line. */}
          {budget.balance < evalRunPointsPerRow(1) && (
            <p className="mt-2 text-sm text-danger-fg" data-testid="points-exhausted">
              Your team doesn&apos;t have enough Eval Points left to start new
              runs. Points reset when the period does{plan.slug === "free" ? " — or sooner on a larger plan" : ""}.
            </p>
          )}
        </section>

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
