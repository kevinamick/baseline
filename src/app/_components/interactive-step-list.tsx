"use client";

import { useState, useEffect } from "react";
import type { CategoryStep } from "@/lib/marketing/categories";
import { CheckIcon } from "@/app/_components/icons";

const STEP_LINK_LABELS: Record<string, string> = {
  "/rubrics": "Go to Rubrics",
  "/schedules": "Go to Schedules",
  "/optimizations": "Go to Optimizations",
  "/dashboard": "Go to Dashboard",
  "/settings/connections": "Go to Connections",
  "/settings/team": "Go to Team Settings",
};

function stepLinkLabel(href: string): string {
  return STEP_LINK_LABELS[href] ?? "Open in Baseline";
}

/**
 * Client-side interactive version of the guide step list. Each step number is a
 * clickable button that marks the step complete; state persists in localStorage so
 * progress survives page reloads. Renders identically to the static list on first
 * server render, then hydrates into the interactive version.
 */
export function InteractiveStepList({
  steps,
  categorySlug,
}: {
  steps: readonly CategoryStep[];
  categorySlug: string;
}) {
  const storageKey = `guide-progress:${categorySlug}`;

  const [checked, setChecked] = useState<boolean[]>(() =>
    new Array(steps.length).fill(false)
  );
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setChecked(
            new Array(steps.length)
              .fill(false)
              .map((_, i) => Boolean(parsed[i]))
          );
        }
      }
    } catch {
      // localStorage unavailable — stay with default unchecked state
    }
    setHydrated(true);
  }, [storageKey, steps.length]);

  function toggle(index: number) {
    setChecked((prev) => {
      const next = [...prev];
      next[index] = !next[index];
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // ignore write errors
      }
      return next;
    });
  }

  const completedCount = hydrated ? checked.filter(Boolean).length : 0;
  const allDone = hydrated && checked.every(Boolean) && steps.length > 0;
  const anyDone = hydrated && completedCount > 0;

  function reset() {
    const cleared = new Array(steps.length).fill(false);
    setChecked(cleared);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  }

  return (
    <div>
      {hydrated && (
        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[13px] text-fg-3">
              {completedCount} / {steps.length} steps completed
            </span>
            {anyDone && !allDone && (
              <button
                type="button"
                onClick={reset}
                className="text-[12px] text-fg-3 hover:text-fg-2 underline-offset-2 hover:underline"
              >
                Reset progress
              </button>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-fg-3/15">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${steps.length > 0 ? (completedCount / steps.length) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}
      <ol className="flex flex-col gap-4">
      {steps.map((step, i) => {
        const done = hydrated && checked[i];
        return (
          <li key={step.title} className="flex gap-4">
            <button
              type="button"
              onClick={() => toggle(i)}
              aria-label={
                done
                  ? `Unmark step ${i + 1} as complete`
                  : `Mark step ${i + 1} as complete`
              }
              title={done ? "Click to unmark" : "Click to mark complete"}
              className={[
                "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-sm font-semibold transition-colors",
                done
                  ? "bg-accent text-fg-on-ink"
                  : "bg-accent/15 text-accent hover:bg-accent/30",
              ].join(" ")}
            >
              {done ? <CheckIcon size={14} /> : i + 1}
            </button>
            <div
              className={[
                "pt-0.5 transition-opacity",
                done ? "opacity-55" : "",
              ].join(" ")}
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <p
                  className={[
                    "text-[15px] font-semibold",
                    done ? "text-fg-2 line-through" : "text-ink",
                  ].join(" ")}
                >
                  {step.title}
                </p>
                {step.href && (
                  <a
                    href={step.href}
                    className="text-[13px] font-medium text-accent-ink hover:underline"
                  >
                    {stepLinkLabel(step.href)} →
                  </a>
                )}
              </div>
              <p className="mt-1 text-[14px] leading-relaxed text-fg-2">
                {step.description}
              </p>
              {step.tip && (
                <p className="mt-2 rounded-lg bg-accent/8 px-3 py-2 text-[13px] leading-relaxed text-fg-2">
                  <span className="font-semibold text-accent">Tip: </span>
                  {step.tip}
                </p>
              )}
            </div>
          </li>
        );
      })}
      {allDone && (
        <li className="mt-1 flex items-center gap-3 rounded-xl border border-accent/20 bg-accent/8 px-4 py-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-fg-on-ink">
            <CheckIcon size={12} />
          </span>
          <div className="flex flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <p className="text-[14px] font-medium text-accent-ink">
              Guide complete — your progress is saved.
            </p>
            <button
              type="button"
              onClick={reset}
              className="text-[12px] text-accent-ink/70 hover:text-accent-ink underline-offset-2 hover:underline"
            >
              Start over
            </button>
          </div>
        </li>
      )}
    </ol>
    </div>
  );
}
