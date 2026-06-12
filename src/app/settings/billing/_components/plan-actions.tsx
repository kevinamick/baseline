"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import {
  cancelPlan,
  keepPlan,
  scheduleDowngradeToBuilder,
  upgradeToScale,
  type PlanChangeResult,
} from "@/app/actions/billing-plan";

type PendingKind = "cancel" | "downgrade" | null;

interface Props {
  /** The subscribed plan slug ("builder" | "scale"). */
  plan: "builder" | "scale";
  /** ISO date the current period ends — when scheduled changes execute. */
  periodEnd: string | null;
  /** Which change (if any) is already scheduled. */
  pending: PendingKind;
  memberCount: number;
}

const btn =
  "rounded-full border border-hairline-field px-4 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-card-warm";
const dangerBtn =
  "rounded-full border border-hairline-field px-4 py-1.5 text-sm font-medium text-danger-fg transition-colors hover:bg-card-warm";

/**
 * Plan-change controls on the Billing page (#182). Upgrades apply immediately
 * (prorated); downgrades and cancellation schedule for period end and are
 * reversible via "Keep my plan" until they execute. Each action confirms
 * through the standard guarded dialog.
 */
export function PlanActions({ plan, periodEnd, pending, memberCount }: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<
    "upgrade" | "downgrade" | "cancel" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const endDate = periodEnd
    ? new Date(periodEnd).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : "the end of the period";

  function run(action: () => Promise<PlanChangeResult>) {
    startTransition(async () => {
      setError(null);
      const result = await action();
      if ("error" in result) {
        setError(result.error);
      }
      setConfirming(null);
      router.refresh();
    });
  }

  if (pending) {
    return (
      <div className="flex flex-col items-end gap-2">
        <button type="button" onClick={() => run(keepPlan)} disabled={busy} className={btn}>
          {busy ? "Reverting…" : "Keep my plan"}
        </button>
        {error && (
          <p role="alert" className="max-w-xs text-right text-xs text-danger-fg">
            {error}
          </p>
        )}
      </div>
    );
  }

  // The seat wall (#182): scheduling a downgrade to Free requires membership
  // to fit the Free seat cap FIRST. The server re-checks; this just explains.
  const seatWall = memberCount > 1;

  return (
    <div className="flex flex-col items-end gap-2">
      {plan === "builder" && (
        <button
          type="button"
          onClick={() => setConfirming("upgrade")}
          disabled={busy}
          className={btn}
        >
          Upgrade to Scale
        </button>
      )}
      {plan === "scale" && (
        <button
          type="button"
          onClick={() => setConfirming("downgrade")}
          disabled={busy}
          className={btn}
        >
          Switch to Builder
        </button>
      )}
      <button
        type="button"
        data-testid="cancel-plan"
        onClick={() => setConfirming("cancel")}
        disabled={busy}
        className={dangerBtn}
      >
        Cancel plan
      </button>
      {error && (
        <p role="alert" className="max-w-xs text-right text-xs text-danger-fg">
          {error}
        </p>
      )}

      {confirming === "upgrade" && (
        <ConfirmDialog
          title="Upgrade to Scale?"
          message="The upgrade applies immediately: Stripe prorates the charge for the rest of the period, and your team's quotas grow right away."
          confirmLabel="Upgrade"
          busy={busy}
          busyLabel="Upgrading…"
          destructive={false}
          onConfirm={() => run(upgradeToScale)}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming === "downgrade" && (
        <ConfirmDialog
          title="Switch to Builder?"
          message={`Your team stays on Scale until ${endDate}, then switches to Builder. You can change your mind any time before then.`}
          confirmLabel="Schedule switch"
          busy={busy}
          busyLabel="Scheduling…"
          onConfirm={() => run(scheduleDowngradeToBuilder)}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming === "cancel" && (
        <ConfirmDialog
          title="Cancel your plan?"
          message={
            seatWall ? (
              <>
                The Free plan includes <strong>1 seat</strong>, but your team
                has <strong>{memberCount} members</strong>. Remove members on
                the Team settings page to continue — billing never removes
                anyone for you.
              </>
            ) : (
              <>
                Your team keeps paid access until <strong>{endDate}</strong>,
                then moves to the Free plan. Nothing is refunded mid-period,
                and you can change your mind any time before then.
              </>
            )
          }
          confirmLabel={seatWall ? "Got it" : "Cancel plan"}
          busy={busy}
          busyLabel="Scheduling…"
          onConfirm={() => {
            if (seatWall) {
              setConfirming(null);
              return;
            }
            run(cancelPlan);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
