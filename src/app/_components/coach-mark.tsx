"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnyModalOpen } from "@/app/_components/modal-presence";

interface CoachMarkProps {
  /**
   * Whether this coach-mark is the active one. A coach-mark is non-blocking and
   * has no dismiss control — it appears while `active` is true and vanishes when
   * the step it teaches is satisfied (the caller flips `active` to false).
   */
  active: boolean;
  /** Headline (the teaching title). Lives in the i18n catalog, not inline. */
  title: string;
  /** Verbose teaching body copy. Lives in the i18n catalog, not inline. */
  message: string;
  /** The target element the coach-mark pins to and highlights. */
  children: React.ReactNode;
}

/**
 * A reusable, non-blocking coach-mark, styled per the Baseline Design System
 * coach-mark handoff: a dark cobalt-navy `ink-soft` focus surface with a light
 * title + muted body and a pointer arrow, plus a cobalt spotlight ring on the
 * live target. The popup is portalled to `document.body` so it escapes any
 * `overflow-hidden` ancestor, and is `pointer-events-none` so the rest of the
 * page — including the highlighted control itself — stays fully interactive.
 * There is no dimming, scrim, overlay, modal trap, or dismiss button (#331): a
 * coach-mark goes away only when its derived step is satisfied.
 */
export function CoachMark({ active, title, message, children }: CoachMarkProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  // A coach-mark must never sit on top of — or compete for clicks with — a modal.
  // While any dialog is open we drop both the popup and the target ring, and
  // restore them (re-measuring the anchor) once it closes.
  const modalOpen = useAnyModalOpen();
  const show = active && !modalOpen;

  useLayoutEffect(() => {
    // No measurement while hidden; the popup render is gated on `show` too, so a
    // stale rect is never shown.
    if (!show) return;
    const el = anchorRef.current;
    if (!el) return;

    const measure = () => setRect(el.getBoundingClientRect());
    measure();

    // Coalesce scroll/resize bursts into a single measurement per frame so we
    // don't force a synchronous reflow + re-render on every event.
    let frame: number | null = null;
    const scheduleMeasure = () => {
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };

    // Re-pin on layout shifts (resize, scroll of any ancestor).
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener("scroll", scheduleMeasure, true);
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("scroll", scheduleMeasure, true);
    };
  }, [show]);

  return (
    <span
      ref={anchorRef}
      className={
        show
          ? "inline-flex rounded-full transition-shadow coach-spotlight"
          : "inline-flex rounded-full transition-shadow"
      }
    >
      {children}
      {show && rect != null && (
        <CoachMarkPopup rect={rect} title={title} message={message} />
      )}
    </span>
  );
}

// Surface max-width per the design handoff (~372px), left a touch narrower so a
// fixed-width portal anchored in the left panel keeps a viewport gutter.
const POPUP_WIDTH = 360;
const ARROW_SIZE = 14;

function CoachMarkPopup({
  rect,
  title,
  message,
}: {
  rect: DOMRect;
  title: string;
  message: string;
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
      className="form-reveal pointer-events-none fixed z-[60]"
      style={{ top, left, width: POPUP_WIDTH }}
      data-testid="coach-mark"
    >
      {/* Pointer arrow: a 14px square rotated 45°, same fill as the surface, with
          a softly-rounded tip, sliding along the top edge to point at the target.
          In dark mode the surface no longer separates from the (also-dark) page by
          shadow alone, so a 1px dark-hairline edge defines it; on the arrow only
          the two exposed (top/left → tip) edges carry it. Light mode is unchanged. */}
      <div
        aria-hidden="true"
        className="absolute rotate-45 rounded-[3px] bg-ink-soft dark:border-l dark:border-t dark:border-hairline"
        style={{
          top: -(ARROW_SIZE / 2),
          left: arrowLeft - ARROW_SIZE / 2,
          height: ARROW_SIZE,
          width: ARROW_SIZE,
        }}
      />
      <div className="relative flex flex-col gap-[9px] rounded-[20px] bg-ink-soft px-5 pb-4 pt-[18px] shadow-xl dark:border dark:border-hairline">
        <h3 className="text-base font-semibold tracking-[-0.01em] text-white">
          {title}
        </h3>
        <p className="text-[13px] leading-[1.5] text-fg-on-ink-muted">{message}</p>
      </div>
    </div>,
    document.body,
  );
}
