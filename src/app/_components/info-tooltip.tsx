"use client";

import { useState, useId, useRef, useLayoutEffect } from "react";
import { InfoCircleIcon } from "@/app/_components/icons";

interface InfoTooltipProps {
  content: string;
}

export function InfoTooltip({ content }: InfoTooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"top" | "bottom">("top");
  const [offsetX, setOffsetX] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !tooltipRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    // Use the tooltip's layout size — offsetWidth/Height are unaffected by the
    // CSS transform we apply, so the math stays correct on repeat hovers (a
    // transformed getBoundingClientRect would reflect the *previous* offset and
    // drift back to overflowing on the second open).
    const tipWidth = tooltipRef.current.offsetWidth;
    const tipHeight = tooltipRef.current.offsetHeight;

    // The tooltip is bounded by the nearest scrollable ancestor (e.g. a
    // dialog's overflow-y-auto body, whose overflow-x then computes to auto).
    // Measure against that box — not the viewport — so the centered, fixed-
    // width tooltip neither clips above nor overflows sideways into a scrollbar.
    let bounds = {
      top: 0,
      left: 0,
      right:
        typeof document === "undefined"
          ? Infinity
          : document.documentElement.clientWidth,
    };
    let el = triggerRef.current.parentElement;
    while (el) {
      const { overflowX, overflowY } = getComputedStyle(el);
      if (/(auto|scroll)/.test(overflowX) || /(auto|scroll)/.test(overflowY)) {
        const r = el.getBoundingClientRect();
        // Clamp to the content box, not the border box: a classic (non-overlay)
        // scrollbar — e.g. on Windows — takes layout space, and a tooltip placed
        // under it still counts as horizontal overflow and spawns an x-scrollbar.
        const contentLeft = r.left + el.clientLeft;
        bounds = {
          top: r.top,
          left: contentLeft,
          right: contentLeft + el.clientWidth,
        };
        break;
      }
      el = el.parentElement;
    }

    // Flip below only when the tooltip's real height wouldn't fit above.
    setPlacement(rect.top - bounds.top < tipHeight + 12 ? "bottom" : "top");

    // Clamp horizontally: derive the centered position from the trigger and the
    // tooltip width, then shift back inside the bounds (with a small margin)
    // while keeping the arrow pointed at the trigger.
    const margin = 8;
    const center = rect.left + rect.width / 2;
    const centeredLeft = center - tipWidth / 2;
    const centeredRight = center + tipWidth / 2;
    let dx = 0;
    if (centeredLeft < bounds.left + margin) {
      dx = bounds.left + margin - centeredLeft;
    } else if (centeredRight > bounds.right - margin) {
      dx = bounds.right - margin - centeredRight;
    }
    setOffsetX(dx);
  }, [open]);

  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="flex items-center text-fg-3 hover:text-fg-2 transition-colors"
        aria-label="More information"
      >
        <InfoCircleIcon size={13} />
      </button>
      {open && (
        <span
          ref={tooltipRef}
          role="tooltip"
          id={id}
          style={{ transform: `translateX(calc(-50% + ${offsetX}px))` }}
          className={`pointer-events-none absolute left-1/2 z-50 w-56 rounded-lg bg-ink px-3 py-2 text-xs leading-relaxed text-fg-on-ink shadow-lg ${
            placement === "top" ? "bottom-full mb-2" : "top-full mt-2"
          }`}
        >
          {content}
          <span
            aria-hidden="true"
            style={{ transform: `translateX(calc(-50% - ${offsetX}px))` }}
            className={`absolute left-1/2 border-[5px] border-transparent ${
              placement === "top"
                ? "top-full border-t-ink"
                : "bottom-full border-b-ink"
            }`}
          />
        </span>
      )}
    </span>
  );
}
