"use client";

import { useTranslations } from "next-intl";
import { CheckIcon } from "@/app/_components/icons";
import { useOnboarding } from "./onboarding-context";
import { useLingeringVisibility } from "./use-lingering-visibility";

/**
 * The "Getting started" progress card pinned to the top of /rubrics (below the
 * KPI header, above the two-pane layout). It renders while a step is unsatisfied
 * and, because progress is derived from live data, does NOT vanish the instant
 * the final step flips to satisfied: it lingers through the current render
 * (briefly showing the completed checklist) and falls away only on the next
 * render, after data revalidation. The card persists nothing.
 */
export function GettingStartedCard() {
  const t = useTranslations("Rubrics.onboarding");
  const onboarding = useOnboarding();

  // Active while an unsatisfied step exists; deferred so the hide is tied to the
  // next render rather than the optimistic moment the data flips satisfied.
  const live = onboarding != null && onboarding.active != null;
  const visible = useLingeringVisibility(live);

  // Hidden once no step is active and the linger window has elapsed (or readonly,
  // or a Team that already had a rubric on first paint — which never flickers in).
  if (!onboarding || !visible) return null;

  const { steps, active, completed, total, data } = onboarding;

  return (
    <section
      aria-label={t("cardTitle")}
      data-testid="onboarding-card"
      className="form-reveal shrink-0 rounded-[20px] border border-accent/25 bg-accent-soft/40 px-5 py-4"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">
            {t("cardTitle")}
          </h2>
          <p className="text-[13px] text-fg-2">{t("cardSubtitle")}</p>
        </div>
        <span className="shrink-0 rounded-full bg-accent px-2.5 py-1 font-mono text-xs font-bold tabular-nums tracking-wide text-fg-on-accent">
          {t("progress", { completed, total })}
        </span>
      </div>

      <ol className="mt-3 flex flex-col gap-1.5">
        {steps.map((step) => {
          // `active` is null during the lingering render (every step satisfied);
          // nothing is highlighted then — the checklist simply reads complete.
          const isActive = active != null && step.id === active.id;
          const isDone = step.isSatisfied(data);
          return (
            <li key={step.id} className="flex items-center gap-2.5 text-sm">
              <span
                aria-hidden="true"
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                  isDone
                    ? "border-accent bg-accent text-fg-on-accent"
                    : isActive
                      ? "border-accent text-accent"
                      : "border-hairline text-fg-3"
                }`}
              >
                {isDone ? <CheckIcon size={11} /> : null}
              </span>
              <span className={isActive ? "font-medium text-ink" : "text-fg-2"}>
                {t(`steps.${step.id}.label`)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
