"use client";

import { useEffect, useRef } from "react";

interface ConfirmDialogProps {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Disables both buttons + shows the busy label while the action runs. */
  busy?: boolean;
  busyLabel?: string;
  /** Red confirm button for destructive actions (default true). */
  destructive?: boolean;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// A confirmation dialog for destructive actions. Unlike the primary Dialog, Escape and a
// backdrop click do NOT dismiss it — the user must make an explicit choice (Cancel/Confirm).
// This preserves the destructive-action guardrail (a reflexive Esc can't ambiguously dismiss
// the prompt). Focus lands on Cancel, the safe default.
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  busy = false,
  busyLabel = "Working…",
  destructive = true,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Focus the safe default (Cancel) rather than the destructive action.
    cancelRef.current?.focus();

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Trap Tab inside the dialog. Escape is deliberately NOT handled — a destructive
    // confirmation must be answered explicitly, not dismissed by reflex.
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      );
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const insideDialog = !!active && dialogRef.current.contains(active);
      if (!insideDialog) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && (active === first || active === dialogRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = originalOverflow;
      // The opener (e.g. the "Cancel run" button) may have unmounted while the dialog was open —
      // the confirmed action can remove it. Only refocus it if it's still in the document.
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      {/* Backdrop is inert — clicking it does NOT dismiss a destructive confirmation. */}
      <div className="absolute inset-0 bg-ink/45" />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative z-10 flex w-full max-w-md flex-col gap-4 rounded-2xl border border-hairline-cool bg-white p-6 shadow-xl outline-none form-reveal"
      >
        <div className="flex flex-col gap-1.5">
          <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">{title}</h2>
          <div className="text-sm text-zinc-600">{message}</div>
        </div>
        <div className="flex items-center justify-end gap-2.5">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-full border border-hairline-cool bg-white px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-full px-5 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
              destructive ? "bg-red-500 hover:bg-red-600" : "bg-ink hover:bg-ink-soft"
            }`}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
