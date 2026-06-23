"use client";

import { useState, useEffect } from "react";
import type { CategoryStep } from "@/lib/marketing/categories";
import { CheckIcon } from "@/app/_components/icons";

function CodeCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          // Clipboard unavailable — fail quietly
        }
      }}
      className="rounded px-1.5 py-0.5 text-[11px] font-medium text-fg-3 transition-colors hover:bg-ink/[0.06] hover:text-fg-2"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function difficultyBadgeClass(level: string): string {
  if (level === "Beginner") return "bg-success-bg text-success-fg";
  if (level === "Advanced") return "bg-accent/10 text-accent-ink";
  return "bg-fg-3/10 text-fg-3";
}

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
  relatedCategories,
  afterGuideNote,
}: {
  steps: readonly CategoryStep[];
  categorySlug: string;
  relatedCategories?: readonly { slug: string; heading: string; stepsGoal?: string; timeToComplete?: string; stepCount?: number; difficulty?: string }[];
  afterGuideNote?: string;
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
    const next = [...checked];
    next[index] = !next[index];
    setChecked(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // ignore write errors
    }
    // After marking a step done, scroll the next unchecked step into view.
    if (next[index]) {
      const nextUnchecked = next.findIndex((v, i) => i > index && !v);
      if (nextUnchecked >= 0) {
        requestAnimationFrame(() => {
          document
            .getElementById(`step-${nextUnchecked + 1}`)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    }
  }

  function jumpToNextStep() {
    const nextUnchecked = checked.findIndex((v) => !v);
    if (nextUnchecked >= 0) {
      document
        .getElementById(`step-${nextUnchecked + 1}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
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
              {completedCount === 0
                ? "Click a step to track your progress"
                : `${completedCount} / ${steps.length} steps completed`}
            </span>
            {anyDone && !allDone && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={jumpToNextStep}
                  className="text-[12px] font-medium text-accent-ink hover:underline underline-offset-2"
                >
                  Jump to next step →
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="text-[12px] text-fg-3 hover:text-fg-2 underline-offset-2 hover:underline"
                >
                  Reset
                </button>
              </div>
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
          <li key={step.title} id={`step-${i + 1}`} className="flex gap-4">
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
                    target="_blank"
                    rel="noopener noreferrer"
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
              {step.codeExample && (
                <div className="relative mt-2">
                  {step.codeExampleLabel && (
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-3">
                      {step.codeExampleLabel}
                    </p>
                  )}
                  <div className="relative">
                    <pre className="overflow-x-auto rounded-lg bg-ink/[0.04] px-3 py-2.5 pb-7 text-[12px] leading-relaxed text-fg-2 font-mono">
                      <code>{step.codeExample}</code>
                    </pre>
                    <div className="absolute bottom-1.5 right-1.5">
                      <CodeCopyButton text={step.codeExample} />
                    </div>
                  </div>
                </div>
              )}
              {step.expectedResult && (
                <p className="mt-2 rounded-lg bg-success-bg px-3 py-2 text-[13px] leading-relaxed text-success-fg">
                  <span className="font-semibold">You&apos;ll see: </span>
                  {step.expectedResult}
                </p>
              )}
            </div>
          </li>
        );
      })}
      {allDone && (
        <li className="mt-1 rounded-xl border border-accent/20 bg-accent/8 px-4 py-4">
          <div className="flex items-start gap-3">
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
          </div>
          {afterGuideNote && (
            <p className="mt-3 border-t border-accent/20 pt-3 text-[13px] leading-relaxed text-accent-ink/80">
              {afterGuideNote}
            </p>
          )}
          {relatedCategories && relatedCategories.length > 0 && (
            <div className={afterGuideNote ? "mt-3" : "mt-3 border-t border-accent/20 pt-3"}>
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-accent-ink/60">
                What to try next
              </p>
              <ul className="flex flex-col gap-1.5">
                {relatedCategories.slice(0, 2).map((rel) => (
                  <li key={rel.slug}>
                    <a
                      href={`/${rel.slug}`}
                      className="group flex items-start justify-between gap-2 rounded-lg px-3 py-2 transition-colors hover:bg-accent/10"
                    >
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[13px] font-medium text-accent-ink">
                          {rel.heading}
                        </span>
                        {rel.stepsGoal && (
                          <span className="line-clamp-1 text-[12px] text-accent-ink/60">
                            {rel.stepsGoal}
                          </span>
                        )}
                        {(rel.stepCount != null || rel.timeToComplete != null || rel.difficulty != null) && (
                          <div className="mt-0.5 flex flex-wrap gap-1.5">
                            {rel.difficulty != null && (
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${difficultyBadgeClass(rel.difficulty)}`}>
                                {rel.difficulty}
                              </span>
                            )}
                            {rel.stepCount != null && (
                              <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent-ink">
                                {rel.stepCount} steps
                              </span>
                            )}
                            {rel.timeToComplete != null && (
                              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent-ink/70">
                                {rel.timeToComplete}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <span aria-hidden="true" className="mt-[2px] shrink-0 text-accent-ink/60">→</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </li>
      )}
    </ol>
    </div>
  );
}
