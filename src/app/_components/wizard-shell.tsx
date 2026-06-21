"use client";

import { useState } from "react";
import { Dialog } from "./dialog";
import { XIcon } from "./icons";

// The shared chrome + nav state machine for the stepped wizard dialogs (optimization,
// schedules, …). The shell owns the Dialog, step-pills header, slide wrapper, and
// Back/Next/Confirm footer; consumers keep their own steps, per-step validation, and
// step content.

export interface WizardNav {
  /** Active step index, clamped to the current step list. */
  step: number;
  /** Active step name — render step content by NAME so a shifting index never points at the wrong panel. */
  stepName: string;
  /** The active step list (may change between renders, e.g. schedules' agent vs dataset flows). */
  steps: readonly string[];
  direction: "right" | "left";
  stepError: string | null;
  submitError: string | null;
  submitting: boolean;
  /**
   * The highest step index the user has ever successfully navigated to (via goNext).
   * Breadcrumb steps up to this index are rendered as interactive buttons.
   */
  maxReachedStep: number;
  goNext: () => void;
  goBack: () => void;
  goToStep: (name: string, error: string) => void;
  /** Jump to a step by index (for breadcrumb clicks); clears the step error. */
  goToStepByIndex: (target: number) => void;
  setStepError: (error: string | null) => void;
  setSubmitError: (error: string | null) => void;
  setSubmitting: (submitting: boolean) => void;
}

// The wizard nav state machine: step/direction/stepError/submitError/submitting plus
// goNext (validate, then advance) and goBack (always allowed). `steps` may shrink between
// renders, so the active index is clamped before resolving the step name.
export function useWizardNav(
  steps: readonly string[],
  validateStep: (stepName: string) => string | null
): WizardNav {
  const [step, setStep] = useState(0);
  const [maxReachedStep, setMaxReachedStep] = useState(0);
  const [direction, setDirection] = useState<"right" | "left">("right");
  const [stepError, setStepError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const safeStep = Math.min(step, steps.length - 1);
  const stepName = steps[safeStep];

  // goNext/goBack step from the CLAMPED index: if `steps` shrank since the last
  // navigation (e.g. schedules' dataset→agent flow), the raw index may sit past the
  // end, and stepping from it would make the first click a visual no-op.
  function goNext() {
    const err = validateStep(stepName);
    if (err) {
      setStepError(err);
      return;
    }
    setStepError(null);
    setDirection("right");
    const next = Math.min(Math.min(safeStep, steps.length - 1) + 1, steps.length - 1);
    setMaxReachedStep((m) => Math.max(m, next));
    setStep(next);
  }

  function goBack() {
    setStepError(null);
    setDirection("left");
    setStep((s) => Math.max(Math.min(s, steps.length - 1) - 1, 0));
  }

  // Jump to a named step with an error — e.g. a submit-time check failing on a step the
  // user already passed. The slide direction follows the jump (backward jumps slide in
  // from the left). If `name` is not in the ACTIVE step list (a consumer with dynamic
  // flows passing a step from the other flow), the call is a no-op: navigating nowhere
  // while attaching the error to the current panel would mislead the user.
  function goToStep(name: string, error: string) {
    const i = steps.indexOf(name);
    if (i < 0) return;
    setDirection(i < safeStep ? "left" : "right");
    setStep(i);
    setStepError(error);
  }

  // Jump to a step by index for breadcrumb clicks — clears the step error rather than
  // setting one. No-ops if target equals current step.
  function goToStepByIndex(target: number) {
    if (target === safeStep) return;
    setStepError(null);
    setDirection(target < safeStep ? "left" : "right");
    setStep(target);
  }

  return {
    step: safeStep,
    stepName,
    steps,
    direction,
    stepError,
    submitError,
    submitting,
    maxReachedStep,
    goNext,
    goBack,
    goToStep,
    goToStepByIndex,
    setStepError,
    setSubmitError,
    setSubmitting,
  };
}

interface WizardShellProps {
  title: string;
  /** Heading id wired to the Dialog's aria-labelledby. */
  titleId: string;
  nav: WizardNav;
  onClose: () => void;
  onSubmit: () => void;
  /** Confirm-button label, e.g. "Start run" / "Create schedule". */
  submitLabel: string;
  /** Confirm-button label while submitting, e.g. "Starting…" / "Creating…". */
  submittingLabel: string;
  /** The active step's content (render by nav.stepName). */
  children: React.ReactNode;
}

export function WizardShell({
  title,
  titleId,
  nav,
  onClose,
  onSubmit,
  submitLabel,
  submittingLabel,
  children,
}: WizardShellProps) {
  return (
    <Dialog onClose={onClose} ariaLabelledBy={titleId} className="max-w-2xl h-[90vh]">
      {/* Header + step progress */}
      <div className="shrink-0 border-b border-hairline px-6 py-4">
        <div className="flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-semibold tracking-[-0.015em]">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-paper-warm text-fg-2 outline-none transition-colors hover:bg-paper hover:text-ink focus-visible:ring-[3px] focus-visible:ring-accent/40"
          >
            <XIcon size={14} />
          </button>
        </div>
        <ol aria-label="Steps" className="mt-4 flex items-center gap-1.5">
          {nav.steps.map((label, i) => {
            const isCurrent = i === nav.step;
            const isReachable = !isCurrent && i <= nav.maxReachedStep;
            const cls = `inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium transition-colors ${
              isCurrent
                ? "bg-ink text-fg-on-ink"
                : isReachable
                  ? "bg-accent-soft text-accent-ink cursor-pointer hover:bg-accent hover:text-white"
                  : "bg-paper-warm text-fg-2"
            }`;
            return (
              <li
                key={label}
                aria-current={isCurrent ? "step" : undefined}
                className="flex items-center gap-1.5"
              >
                {isReachable ? (
                  <button
                    type="button"
                    onClick={() => nav.goToStepByIndex(i)}
                    aria-label={`Go to ${label} step`}
                    className={cls}
                  >
                    {label}
                  </button>
                ) : (
                  <span className={cls}>{label}</span>
                )}
                {i < nav.steps.length - 1 && (
                  <span aria-hidden="true" className="text-fg-4">
                    ·
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {/* Body — only the active step is rendered, animated by direction */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div key={nav.step} className={nav.direction === "right" ? "wizard-in-right" : "wizard-in-left"}>
          {nav.stepError && (
            <p role="alert" className="mb-4 text-sm text-danger-fg">
              {nav.stepError}
            </p>
          )}
          {children}
        </div>
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-between border-t border-hairline bg-paper-warm px-6 py-3.5">
        <button
          type="button"
          onClick={nav.goBack}
          disabled={nav.step === 0}
          className="rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm text-ink outline-none transition-colors hover:bg-card-warm focus-visible:ring-[3px] focus-visible:ring-accent/40 disabled:opacity-40 disabled:hover:bg-card"
        >
          Back
        </button>
        {nav.step < nav.steps.length - 1 ? (
          <button
            type="button"
            onClick={nav.goNext}
            className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-fg-on-ink outline-none transition-colors hover:bg-ink-hover focus-visible:ring-[3px] focus-visible:ring-accent/40"
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            disabled={nav.submitting}
            className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-fg-on-ink outline-none transition-colors hover:bg-ink-hover focus-visible:ring-[3px] focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {nav.submitting ? submittingLabel : submitLabel}
          </button>
        )}
      </div>
    </Dialog>
  );
}
