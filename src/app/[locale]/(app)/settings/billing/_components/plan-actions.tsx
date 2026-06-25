"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import { pillBtnCls, pillDangerBtnCls } from "@/app/_components/form-styles";
import { PLANS, type PaidPlanSlug } from "@/lib/billing/plans";
import {
  cancelPlan,
  keepPlan,
  scheduleDowngradeToBuilder,
  upgradeToScale,
  type PlanChangeResult,
} from "@/app/actions/billing-plan";

type PendingKind = "cancel" | "downgrade" | null;

interface Props {
  /** The subscribed plan slug. */
  plan: PaidPlanSlug;
  /** Formatted date the current period ends — when scheduled changes execute. */
  periodEndLabel: string | null;
  /** Which change (if any) is already scheduled. */
  pending: PendingKind;
  memberCount: number;
  /** False while the subscription is out of good standing (past_due/unpaid):
   *  cancelling and reverting stay available, growing the plan does not. */
  upgradeAllowed: boolean;
}

/**
 * Plan-change controls on the Billing page (#182). Upgrades apply immediately
 * (prorated); downgrades and cancellation schedule for period end and are
 * reversible via "Keep my plan" until they execute. Each action confirms
 * through the standard guarded dialog.
 */
export function PlanActions({
  plan,
  periodEndLabel,
  pending,
  memberCount,
  upgradeAllowed,
}: Props) {
  const router = useRouter();
  const t = useTranslations("Settings.billing.actions");
  const [confirming, setConfirming] = useState<
    "upgrade" | "downgrade" | "cancel" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const endDate = periodEndLabel ?? t("endOfPeriod");

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

  const errorAlert = error && (
    <p role="alert" className="max-w-xs text-right text-xs text-danger-fg">
      {error}
    </p>
  );

  if (pending) {
    return (
      <div className="flex flex-col items-end gap-2">
        <button
          type="button"
          onClick={() => run(keepPlan)}
          disabled={busy}
          className={pillBtnCls}
        >
          {busy ? t("reverting") : t("keepPlan")}
        </button>
        {errorAlert}
      </div>
    );
  }

  // The seat wall (#182): scheduling a downgrade to Free requires membership
  // to fit the Free seat cap FIRST. The server re-checks; this just explains.
  const freeSeatLimit = PLANS.free.seatLimit ?? 1;
  const seatWall = memberCount > freeSeatLimit;

  return (
    <div className="flex flex-col items-end gap-2">
      {upgradeAllowed && plan === "builder" && (
        <button
          type="button"
          onClick={() => setConfirming("upgrade")}
          disabled={busy}
          className={pillBtnCls}
        >
          {t("upgradeToScale")}
        </button>
      )}
      {upgradeAllowed && plan === "scale" && (
        <button
          type="button"
          onClick={() => setConfirming("downgrade")}
          disabled={busy}
          className={pillBtnCls}
        >
          {t("switchToBuilder")}
        </button>
      )}
      <button
        type="button"
        data-testid="cancel-plan"
        onClick={() => setConfirming("cancel")}
        disabled={busy}
        className={pillDangerBtnCls}
      >
        {t("cancelPlan")}
      </button>
      {errorAlert}

      {confirming === "upgrade" && (
        <ConfirmDialog
          title={t("upgradeTitle")}
          message={t("upgradeMessage")}
          confirmLabel={t("upgradeConfirm")}
          busy={busy}
          busyLabel={t("upgrading")}
          destructive={false}
          onConfirm={() => run(upgradeToScale)}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming === "downgrade" && (
        <ConfirmDialog
          title={t("downgradeTitle")}
          message={t("downgradeMessage", { date: endDate })}
          confirmLabel={t("downgradeConfirm")}
          busy={busy}
          busyLabel={t("scheduling")}
          onConfirm={() => run(scheduleDowngradeToBuilder)}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming === "cancel" && (
        <ConfirmDialog
          title={t("cancelTitle")}
          message={
            seatWall
              ? t.rich("cancelSeatWall", {
                  count: freeSeatLimit,
                  members: memberCount,
                  strong: (chunks) => <strong>{chunks}</strong>,
                })
              : t.rich("cancelMessage", {
                  date: endDate,
                  strong: (chunks) => <strong>{chunks}</strong>,
                })
          }
          confirmLabel={seatWall ? t("cancelSeatWallConfirm") : t("cancelConfirm")}
          busy={busy}
          busyLabel={t("scheduling")}
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
