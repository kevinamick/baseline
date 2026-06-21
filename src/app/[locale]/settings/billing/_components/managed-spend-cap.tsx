"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Dialog } from "@/app/_components/dialog";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import { inputCls, pillBtnCls, pillDangerBtnCls } from "@/app/_components/form-styles";
import { fmtUsd } from "@/lib/billing/format";
import {
  resetManagedSpendCap,
  setManagedSpendCap,
  type ManagedSpendCapResult,
} from "@/app/actions/billing-managed-spend";

interface Props {
  /** Effective monthly cap in dollars (override or plan default). */
  capUsd: number;
  /** True when the cap is the plan default (no Team override set). */
  isDefault: boolean;
  /** The plan default, shown when resetting. */
  defaultCapUsd: number;
  /** Managed token spend accrued this period, in dollars. */
  spentUsd: number;
  /** The plan's managed markup percentage, for the explainer. */
  markupPct: number;
  /** The trust ceiling (#188): the highest the cap may be raised to right now. */
  ceilingUsd: number;
  /** The next tier the Team would unlock by paying more invoices, if any. */
  nextTier: { atPaidInvoices: number; ceilingUsd: number } | null;
}

/**
 * Managed Spend Cap controls (#185, ADR-0008 Meter 2). Managed token spend (paid
 * Teams on the platform key) is billed at provider cost + the plan markup, and
 * bounded by this cap. Each plan ships a default; a Team raises or lowers it.
 * There's no "off" — managed spend is always capped. Resetting to the default
 * goes through the guarded confirm (it changes what running work may cost).
 */
export function ManagedSpendCap({
  capUsd,
  isDefault,
  defaultCapUsd,
  spentUsd,
  markupPct,
  ceilingUsd,
  nextTier,
}: Props) {
  const router = useRouter();
  const t = useTranslations("Settings.billing.managedCap");
  const [editing, setEditing] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  function run(action: () => Promise<ManagedSpendCapResult>) {
    startTransition(async () => {
      setError(null);
      const result = await action();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setEditing(false);
      setConfirmingReset(false);
      router.refresh();
    });
  }

  return (
    <section className="mt-6 rounded-2xl border border-hairline-cool bg-card p-6 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-ink">{t("heading")}</h2>
          <p
            className="mt-1 text-2xl font-semibold tabular-nums tracking-[-0.01em] text-ink"
            data-testid="managed-spend-usage"
          >
            {fmtUsd(spentUsd)}
            <span className="ml-1.5 text-sm font-normal text-fg-3">
              {t("usage", { cap: fmtUsd(capUsd) })}
            </span>
          </p>
          <p className="mt-1 text-xs text-fg-3">
            {isDefault
              ? t("blurbDefault", { pct: markupPct })
              : t("blurbCustom", { pct: markupPct })}
          </p>
          <p className="mt-2 text-xs text-fg-3" data-testid="trust-ceiling">
            {t("ceiling", { ceiling: fmtUsd(ceilingUsd) })}
            {nextTier && (
              <>
                {t("nextTier", {
                  count: nextTier.atPaidInvoices,
                  ceiling: fmtUsd(nextTier.ceilingUsd),
                })}
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <button
            type="button"
            data-testid="managed-cap-button"
            onClick={() => setEditing(true)}
            disabled={busy}
            className={pillBtnCls}
          >
            {t("editCap")}
          </button>
          {!isDefault && (
            <button
              type="button"
              data-testid="managed-cap-reset-button"
              onClick={() => setConfirmingReset(true)}
              disabled={busy}
              className={pillDangerBtnCls}
            >
              {t("resetToDefault")}
            </button>
          )}
          {error && !editing && (
            <p role="alert" className="max-w-xs text-right text-xs text-danger-fg">
              {error}
            </p>
          )}
        </div>
      </div>

      {editing && (
        <Dialog
          onClose={() => setEditing(false)}
          ariaLabel={t("ariaLabel")}
          className="max-w-md"
        >
          <form
            className="flex flex-col gap-4 p-6"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => setManagedSpendCap(new FormData(e.currentTarget)));
            }}
          >
            <div className="flex flex-col gap-1.5">
              <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
                {t("dialogTitle")}
              </h2>
              <p className="text-sm text-fg-2">
                {t("dialogBlurb", { pct: markupPct })}
              </p>
            </div>
            <label className="flex flex-col gap-1.5 text-sm text-ink">
              {t("monthlyCapLabel")}
              {/* No hard `max`: a raise above the ceiling is refused SERVER-side
                  with legible copy (the ceiling grows with paid invoices), and a
                  native max would silently clamp instead of explaining why. */}
              <input
                name="capUsd"
                type="number"
                min={1}
                step="0.01"
                required
                defaultValue={capUsd}
                className={inputCls}
                autoFocus
              />
              <span className="text-xs text-fg-3">
                {t("ceilingHint", { ceiling: fmtUsd(ceilingUsd) })}
              </span>
            </label>
            {error && (
              <p role="alert" className="text-xs text-danger-fg">
                {error}
              </p>
            )}
            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={busy}
                className="rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm disabled:opacity-50"
              >
                {t("cancel")}
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-hover disabled:opacity-50"
              >
                {busy ? t("saving") : t("saveCap")}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {confirmingReset && (
        <ConfirmDialog
          title={t("confirmResetTitle")}
          message={t("confirmResetMessage", { cap: fmtUsd(defaultCapUsd) })}
          confirmLabel={t("confirmResetConfirm")}
          busy={busy}
          busyLabel={t("resetting")}
          onConfirm={() => run(resetManagedSpendCap)}
          onCancel={() => setConfirmingReset(false)}
        />
      )}
    </section>
  );
}
