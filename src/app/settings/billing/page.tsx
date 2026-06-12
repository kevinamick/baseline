import { getAuthContext } from "@/lib/auth/context";
import { NavBar } from "@/app/_components/nav-bar";
import { redirect } from "next/navigation";
import { getPointBudget, listLedgerEntries, type LedgerEntry } from "@/lib/billing/ledger";
import { PLANS } from "@/lib/billing/plans";

/**
 * Team billing page (#191's hub, seeded here by #180 with the Eval Point
 * balance and the Point Ledger — the Team-visible audit trail ADR-0009
 * promises). Contributor-only, same gate as Team settings; S12 adds the plan
 * card and Stripe Customer Portal, S13 the full usage meters.
 */
export default async function BillingSettingsPage() {
  const { canWrite, orgId } = await getAuthContext();
  if (!canWrite || !orgId) {
    redirect("/rubrics");
  }

  const budget = await getPointBudget(orgId);
  const entries = await listLedgerEntries(orgId, budget.periodStart);
  const plan = PLANS[budget.plan];

  const resetDate = new Date(budget.periodEnd).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const fmt = (n: number) => n.toLocaleString("en-US");

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <NavBar />
      <main className="mx-auto w-full max-w-2xl flex-1 p-6">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">Billing</h1>
        <p className="mt-1 text-sm text-fg-2">
          Your team&apos;s usage for the current billing period.
        </p>

        <section className="mt-6 rounded-2xl border border-hairline-cool bg-card p-6 shadow-card">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-medium text-ink">Eval Points</h2>
            <span className="text-xs text-fg-3">
              {plan.name} plan · resets {resetDate}
            </span>
          </div>
          <p className="mt-3 text-2xl font-semibold tabular-nums tracking-[-0.01em] text-ink" data-testid="point-balance">
            {fmt(Math.max(0, budget.balance))}
            <span className="ml-1.5 text-sm font-normal text-fg-3">
              of {fmt(budget.included)} remaining
            </span>
          </p>
          {budget.balance <= 0 && (
            <p className="mt-2 text-sm text-danger-fg" data-testid="points-exhausted">
              Your team has used its included Eval Points for this period. Runs
              are paused until the period resets{plan.slug === "free" ? " — or sooner on a larger plan" : ""}.
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

function entryLabel(e: LedgerEntry): string {
  switch (e.entryType) {
    case "grant":
      return "Period grant";
    case "reserve":
      return "Reserved for eval run";
    case "settle":
      return "Settled — points consumed";
    case "release":
      return "Released back — unused reservation";
  }
}

/** Signed display follows the balance math: grant/release add, reserve
 * subtracts, settle is balance-neutral (the reservation already paid). */
function entryAmount(e: LedgerEntry): string {
  const n = e.points.toLocaleString("en-US");
  switch (e.entryType) {
    case "grant":
    case "release":
      return `+${n}`;
    case "reserve":
      return `−${n}`;
    case "settle":
      return n;
  }
}

function entryTone(e: LedgerEntry): string {
  switch (e.entryType) {
    case "grant":
    case "release":
      return "text-success-fg";
    case "reserve":
      return "text-danger-fg";
    case "settle":
      return "text-fg-3";
  }
}
