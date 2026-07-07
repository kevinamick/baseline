"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import { createCheckoutSession } from "@/app/actions/checkout";
import type { PaidPlanSlug } from "@/lib/billing/plans";

interface Props {
  orgId: string;
  planSlug: PaidPlanSlug;
  planName: string;
  label: string;
  className: string;
  /**
   * Name of the plan the Team's pending Access Code benefit is restricted
   * to, when it does NOT match this card's plan — null means either there's
   * no pending benefit, or it applies to any plan / this exact plan.
   */
  mismatchedBenefitPlanName: string | null;
}

/**
 * The Subscribe control for a paid plan card (ADR-0017 slice 4, #428). Most
 * cards render as a plain progressive-enhancement `<form>` (unchanged from
 * before this slice) — this client component is only used when the chosen
 * plan mismatches a pending benefit's restriction, so it can interrupt with
 * an explicit forfeit warning before checkout: "restrict the benefit, never
 * the purchase" (ADR-0017) — Confirm still proceeds to checkout at full
 * price and consumes the grant (the same silent-forfeit
 * `evaluateAndConsumeAccessCodeBenefit` already performs); Cancel leaves the
 * grant untouched for a later matching-plan checkout.
 */
export function CheckoutCta({
  orgId,
  planSlug,
  planName,
  label,
  className,
  mismatchedBenefitPlanName,
}: Props) {
  const t = useTranslations("Pricing.mismatch");
  const [confirming, setConfirming] = useState(false);
  const [busy, startTransition] = useTransition();

  if (!mismatchedBenefitPlanName) {
    return (
      <form action={createCheckoutSession.bind(null, orgId, planSlug)}>
        <button type="submit" className={className}>
          {label}
        </button>
      </form>
    );
  }

  return (
    <>
      <button
        type="button"
        data-testid="mismatch-subscribe"
        onClick={() => setConfirming(true)}
        disabled={busy}
        className={className}
      >
        {label}
      </button>
      {confirming && (
        <ConfirmDialog
          title={t("title")}
          message={t("message", {
            benefitPlan: mismatchedBenefitPlanName,
            chosenPlan: planName,
          })}
          confirmLabel={t("confirm")}
          cancelLabel={t("cancel")}
          destructive={false}
          busy={busy}
          busyLabel={t("continuing")}
          onConfirm={() => {
            startTransition(() => {
              createCheckoutSession(orgId, planSlug);
            });
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
