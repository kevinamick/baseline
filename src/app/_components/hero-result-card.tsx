"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckIcon } from "./icons";

// Illustrative marketing numbers (not live data) — the optimized "after" state
// of a support-replies prompt. Criterion fills animate up from 0 on mount.
const CRITERIA: { key: "criterionAccuracy" | "criterionTone" | "criterionResolution"; pct: number }[] = [
  { key: "criterionAccuracy", pct: 96 },
  { key: "criterionTone", pct: 93 },
  { key: "criterionResolution", pct: 91 },
];

/**
 * The hero's "After optimization" result card. The criterion bars fill from 0 to
 * their target width once mounted (a beat after load), honoring reduced motion by
 * snapping straight to target.
 */
export function HeroResultCard() {
  const t = useTranslations("Home");
  const [filled, setFilled] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      // Snap to target on the next frame (not synchronously in the effect body).
      const raf = window.requestAnimationFrame(() => setFilled(true));
      return () => window.cancelAnimationFrame(raf);
    }
    const id = window.setTimeout(() => setFilled(true), 400);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div className="rounded-2xl border border-hairline-cool bg-card p-[26px] shadow-xl">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="mb-1 text-[12.5px] text-fg-3">{t("resultLabel")}</div>
          <div className="text-[17px] font-semibold tracking-[-0.01em] text-ink">
            {t("resultName")}
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success-bg px-2.5 py-1 text-[11px] font-semibold text-success-fg">
          <CheckIcon size={12} />
          {t("resultOptimized")}
        </span>
      </div>

      <div className="flex items-end gap-3">
        <span className="font-mono text-[26px] font-medium tabular-nums text-score-mid-ink line-through opacity-80">
          61%
        </span>
        <span className="pb-1.5 text-fg-4">→</span>
        <span className="font-mono text-[52px] font-bold leading-none tracking-[-0.03em] tabular-nums text-score-high">
          94%
        </span>
      </div>
      <div className="mt-2 text-[13px] text-fg-3">
        {t("resultCaption", { criteria: 3, rows: 24 })}
      </div>

      <div className="mt-5 flex flex-col gap-2.5">
        {CRITERIA.map((c) => (
          <div key={c.key} className="flex items-center gap-3">
            <span className="w-[92px] shrink-0 text-[12.5px] text-fg-2">{t(c.key)}</span>
            <div className="h-[7px] flex-1 overflow-hidden rounded-full bg-paper-warm">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-[900ms] ease-out motion-reduce:transition-none"
                style={{ width: filled ? `${c.pct}%` : "0%" }}
              />
            </div>
            <span className="w-9 text-right font-mono text-xs font-bold tabular-nums text-score-high-ink">
              {c.pct}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
