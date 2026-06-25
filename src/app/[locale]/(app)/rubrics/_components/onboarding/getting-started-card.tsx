"use client";

import { useTranslations } from "next-intl";
import { CheckIcon } from "@/app/_components/icons";
import { useOnboarding } from "./onboarding-context";

/**
 * The "Getting started" progress card pinned to the top of /rubrics (below the
 * KPI header, above the two-pane layout). It renders only while a step is
 * unsatisfied — once every step is satisfied (or the viewer can't write) the
 * card disappears. Progress is derived; the card persists nothing.
 */
export function GettingStartedCard() {
  const t = useTranslations("Rubrics.onboarding");
  const onboarding = useOnboarding();

  // Hidden when there is no active (unsatisfied) step: complete, or readonly.
  if (!onboarding || onboarding.active == null) return null;

  const { steps, active, completed, total, data } = onboarding;

  return (
    <section
      aria-label={t("cardTitle")}
      data-testid="onboarding-card"
      className="coach-pop-in shrink-0 rounded-xl border border-accent/30 bg-accent-soft/40 px-5 py-4"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-semibold tracking-[-0.01em] text-ink">
            {t("cardTitle")}
          </h2>
          <p className="text-[13px] text-fg-2">{t("cardSubtitle")}</p>
        </div>
        <span className="shrink-0 rounded-full bg-accent px-2.5 py-1 font-mono text-xs font-bold tabular-nums text-fg-on-accent">
          {t("progress", { completed, total })}
        </span>
      </div>

      <ol className="mt-3 flex flex-col gap-1.5">
        {steps.map((step) => {
          const isActive = step.id === active.id;
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
