"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Dialog } from "@/app/_components/dialog";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import { inputCls, pillBtnCls, pillDangerBtnCls } from "@/app/_components/form-styles";
import { fmtUsd, fmtRate } from "@/lib/billing/format";
import {
  clearOverageCap,
  setOverageCap,
  type OverageCapResult,
} from "@/app/actions/billing-overage";

interface Props {
  /** null = overage off. */
  capUsd: number | null;
  /** Dollar value of committed overage (reserved + settled past included). */
  committedUsd: number;
  pointsOver: number;
  pointUnitUsd: number;
}


/**
 * Overage Cap controls (#183). Opting in IS typing a cap — the dialog has no
 * bare on/off switch, only the amount. Editing reuses the same dialog;
 * turning overage off goes through the guarded confirm (it changes what
 * running work is allowed to cost).
 */
export function OverageCap({
  capUsd,
  committedUsd,
  pointsOver,
  pointUnitUsd,
}: Props) {
  const router = useRouter();
  const t = useTranslations("Settings.billing.overage");
  const [editing, setEditing] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  function run(action: () => Promise<OverageCapResult>) {
    startTransition(async () => {
      setError(null);
      const result = await action();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setEditing(false);
      setConfirmingOff(false);
      router.refresh();
    });
  }

  return (
    <section className="mt-6 rounded-2xl border border-hairline-cool bg-card p-6 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-ink">{t("heading")}</h2>
          {capUsd == null ? (
            <p className="mt-1 text-sm text-fg-2" data-testid="overage-off">
              {t("off", {
                pointRate: fmtRate(pointUnitUsd),
              })}
            </p>
          ) : (
            <>
              <p
                className="mt-1 text-2xl font-semibold tabular-nums tracking-[-0.01em] text-ink"
                data-testid="overage-usage"
              >
                {fmtUsd(committedUsd)}
                <span className="ml-1.5 text-sm font-normal text-fg-3">
                  {t("usage", { cap: fmtUsd(capUsd) })}
                </span>
              </p>
              {pointsOver > 0 && (
                <p className="mt-1 text-xs text-fg-3" data-testid="overage-breakdown">
                  {t("pointsOver", { count: pointsOver.toLocaleString("en-US") })}
                </p>
              )}
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <button
            type="button"
            data-testid="overage-cap-button"
            onClick={() => setEditing(true)}
            disabled={busy}
            className={pillBtnCls}
          >
            {capUsd == null ? t("setCap") : t("editCap")}
          </button>
          {capUsd != null && (
            <button
              type="button"
              data-testid="overage-off-button"
              onClick={() => setConfirmingOff(true)}
              disabled={busy}
              className={pillDangerBtnCls}
            >
              {t("turnOff")}
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
              run(() => setOverageCap(new FormData(e.currentTarget)));
            }}
          >
            <div className="flex flex-col gap-1.5">
              <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
                {capUsd == null ? t("dialogSetTitle") : t("dialogEditTitle")}
              </h2>
              <p className="text-sm text-fg-2">
                {t("dialogBlurb", {
                  pointRate: fmtRate(pointUnitUsd),
                })}
              </p>
            </div>
            <label className="flex flex-col gap-1.5 text-sm text-ink">
              {t("monthlyCapLabel")}
              <input
                name="capUsd"
                type="number"
                min={1}
                max={10000}
                step="0.01"
                required
                defaultValue={capUsd ?? 25}
                className={inputCls}
                autoFocus
              />
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

      {confirmingOff && (
        <ConfirmDialog
          title={t("confirmOffTitle")}
          message={t("confirmOffMessage")}
          confirmLabel={t("confirmOffConfirm")}
          busy={busy}
          busyLabel={t("turningOff")}
          onConfirm={() => run(clearOverageCap)}
          onCancel={() => setConfirmingOff(false)}
        />
      )}
    </section>
  );
}