"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/app/_components/dialog";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import { inputCls, pillBtnCls, pillDangerBtnCls } from "@/app/_components/form-styles";
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
  runsOver: number;
  pointUnitUsd: number;
  runUnitUsd: number;
}

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });
// Unit rates are sub-cent ($0.0005/point) — currency formatting would round
// them to a flat $0.00.
const fmtRate = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

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
  runsOver,
  pointUnitUsd,
  runUnitUsd,
}: Props) {
  const router = useRouter();
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
          <h2 className="text-sm font-medium text-ink">Overage</h2>
          {capUsd == null ? (
            <p className="mt-1 text-sm text-fg-2" data-testid="overage-off">
              Off — runs stop when your included usage is exhausted. Set a
              monthly cap to let runs continue past it, billed at{" "}
              {fmtRate(pointUnitUsd)}/point and {fmtRate(runUnitUsd)}/run,
              never beyond the cap.
            </p>
          ) : (
            <>
              <p
                className="mt-1 text-2xl font-semibold tabular-nums tracking-[-0.01em] text-ink"
                data-testid="overage-usage"
              >
                {fmtUsd(committedUsd)}
                <span className="ml-1.5 text-sm font-normal text-fg-3">
                  of your {fmtUsd(capUsd)} monthly cap
                </span>
              </p>
              {(pointsOver > 0 || runsOver > 0) && (
                <p className="mt-1 text-xs text-fg-3" data-testid="overage-breakdown">
                  {[
                    pointsOver > 0 &&
                      `${pointsOver.toLocaleString("en-US")} Eval Points over included`,
                    runsOver > 0 &&
                      `${runsOver.toLocaleString("en-US")} Optimization Run${runsOver === 1 ? "" : "s"} over included`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
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
            {capUsd == null ? "Set overage cap" : "Edit cap"}
          </button>
          {capUsd != null && (
            <button
              type="button"
              data-testid="overage-off-button"
              onClick={() => setConfirmingOff(true)}
              disabled={busy}
              className={pillDangerBtnCls}
            >
              Turn off
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
          ariaLabel="Overage cap"
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
                {capUsd == null ? "Set an overage cap" : "Edit the overage cap"}
              </h2>
              <p className="text-sm text-fg-2">
                Runs continue past your included usage, billed at{" "}
                {fmtRate(pointUnitUsd)} per Eval Point and {fmtRate(runUnitUsd)}{" "}
                per Optimization Run — up to this cap, never beyond it. Your
                worst-case invoice is your subscription plus this amount.
              </p>
            </div>
            <label className="flex flex-col gap-1.5 text-sm text-ink">
              Monthly cap (USD)
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
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-hover disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save cap"}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {confirmingOff && (
        <ConfirmDialog
          title="Turn overage off?"
          message="New runs will stop when your included usage is exhausted. Overage already in flight settles and is billed as committed — turning this off only blocks new work."
          confirmLabel="Turn off"
          busy={busy}
          busyLabel="Turning off…"
          onConfirm={() => run(clearOverageCap)}
          onCancel={() => setConfirmingOff(false)}
        />
      )}
    </section>
  );
}