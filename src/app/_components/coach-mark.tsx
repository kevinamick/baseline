"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface CoachMarkProps {
  /**
   * Whether this coach-mark is the active one. A coach-mark is non-blocking and
   * has no dismiss control — it appears while `active` is true and vanishes when
   * the step it teaches is satisfied (the caller flips `active` to false).
   */
  active: boolean;
  /** Verbose teaching copy. Lives in the i18n catalog, not inline. */
  message: string;
  /** Short eyebrow label above the message (e.g. "Getting started"). */
  label?: string;
  /** The target element the coach-mark pins to and highlights. */
  children: React.ReactNode;
}

/**
 * A reusable, non-blocking coach-mark. It wraps a target element, paints a
 * subtle highlight ring/glow on it while active, and pins a verbose teaching
 * popup beside it with an arrow. The popup is portalled to `document.body` so it
 * escapes any `overflow-hidden` ancestor, and is `pointer-events-none` so the
 * rest of the page — including the highlighted control itself — stays fully
 * interactive. There is no dimming, overlay, modal trap, or dismiss button.
 */
export function CoachMark({ active, message, label, children }: CoachMarkProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    // No measurement while inactive; the popup render is gated on `active` too,
    // so a stale rect is never shown.
    if (!active) return;
    const el = anchorRef.current;
    if (!el) return;

    const measure = () => setRect(el.getBoundingClientRect());
    measure();

    // Re-pin on layout shifts (resize, scroll of any ancestor).
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active]);

  return (
    <span
      ref={anchorRef}
      className={
        active
          ? "inline-flex rounded-full ring-2 ring-accent ring-offset-2 ring-offset-card motion-safe:[animation:coach-pulse_2s_ease-in-out_infinite]"
          : "inline-flex"
      }
    >
      {children}
      {active && rect != null && <CoachMarkPopup rect={rect} message={message} label={label} />}
    </span>
  );
}

const POPUP_WIDTH = 288;

function CoachMarkPopup({
  rect,
  message,
  label,
}: {
  rect: DOMRect;
  message: string;
  label?: string;
}) {
  if (typeof document === "undefined") return null;

  const viewportWidth = document.documentElement.clientWidth || POPUP_WIDTH;
  const targetCenterX = rect.left + rect.width / 2;
  const left = Math.min(
    Math.max(8, targetCenterX - POPUP_WIDTH / 2),
    Math.max(8, viewportWidth - POPUP_WIDTH - 8),
  );
  const top = rect.bottom + 10;
  // Arrow sits over the target's horizontal centre, clamped within the popup.
  const arrowLeft = Math.min(Math.max(16, targetCenterX - left), POPUP_WIDTH - 16);

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      // pointer-events-none keeps the page (and the highlighted control) fully
      // clickable even where the popup overlaps it.
      className="coach-pop-in pointer-events-none fixed z-[60]"
      style={{ top, left, width: POPUP_WIDTH }}
      data-testid="coach-mark"
    >
      <div
        aria-hidden="true"
        className="absolute -top-1.5 h-3 w-3 rotate-45 rounded-[2px] border-l border-t border-accent/60 bg-accent"
        style={{ left: arrowLeft - 6 }}
      />
      <div className="relative rounded-xl border border-accent/60 bg-accent text-fg-on-accent shadow-lg">
        <div className="flex flex-col gap-1 px-4 py-3">
          {label && (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-on-accent/80">
              {label}
            </span>
          )}
          <p className="text-sm leading-snug">{message}</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
