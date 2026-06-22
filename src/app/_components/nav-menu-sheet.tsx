"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { MenuIcon, XIcon } from "./icons";

interface NavMenuSheetProps {
  /** Accessible label for the trigger ("Open menu") and the panel. */
  label: string;
  /** Extra classes on the trigger button — the consumer sets the breakpoint at
   *  which the menu shows (e.g. `md:hidden`, `sm:hidden`). */
  triggerClassName?: string;
  /** Viewport width (px) at or above which the menu auto-closes — should match
   *  the breakpoint where the consumer hides the trigger, so a resize from phone
   *  to desktop doesn't strand an open sheet. Defaults to the `md` breakpoint. */
  closeAbovePx?: number;
  /** Panel content. Receives `close` so links can dismiss the sheet on navigate. */
  children: (close: () => void) => ReactNode;
}

/**
 * The mobile nav menu: a hamburger trigger that opens a "paper sheet" dropping in
 * beneath the bar. It reuses the floating-pill material (paper surface, hairline,
 * deep rounding, soft shadow) instead of a full-bleed drawer, so the brand reads
 * the same at 375px as on the desktop. Shared by the landing nav and the app shell.
 *
 * Behavior mirrors the app's other popovers — focus moves into the panel on open
 * and back to the trigger on Escape, an outside tap (the scrim) closes it, body
 * scroll is locked while open — plus a safe-area-aware, scrollable panel.
 */
export function NavMenuSheet({
  label,
  triggerClassName = "",
  closeAbovePx = 768,
  children,
}: NavMenuSheetProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    // Auto-close if the viewport grows past the menu breakpoint (the trigger is
    // hidden there, so an open sheet would otherwise have no way to dismiss).
    const mq = window.matchMedia(`(min-width: ${closeAbovePx}px)`);
    const onChange = () => {
      if (mq.matches) setOpen(false);
    };

    panelRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    document.addEventListener("keydown", onKeyDown);
    mq.addEventListener("change", onChange);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      mq.removeEventListener("change", onChange);
      document.body.style.overflow = originalOverflow;
    };
  }, [open, closeAbovePx]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={label}
        className={`flex h-11 w-11 items-center justify-center rounded-full border border-hairline-cool bg-card text-ink outline-none transition-colors hover:bg-card-warm focus-visible:ring-2 focus-visible:ring-accent/40 ${triggerClassName}`}
      >
        {open ? <XIcon size={18} /> : <MenuIcon size={18} />}
      </button>

      {open && (
        <>
          <div
            className="sheet-scrim-in fixed inset-0 z-40 bg-overlay"
            onClick={close}
            aria-hidden="true"
          />
          <div
            ref={panelRef}
            id={panelId}
            role="menu"
            aria-label={label}
            className="sheet-panel-in px-safe fixed inset-x-3 top-[68px] z-50 flex max-h-[calc(100dvh-84px)] flex-col gap-1 overflow-y-auto rounded-2xl border border-hairline-cool bg-paper-soft p-2 pb-safe-plus shadow-xl"
          >
            {children(close)}
          </div>
        </>
      )}
    </>
  );
}

// Shared item styling for sheet entries — a full-width, comfortably tappable row
// (44px min height clears WCAG 2.5.5). Use for both links and buttons inside the
// sheet so the menu reads as one consistent list.
export const navSheetItem =
  "flex min-h-[44px] items-center rounded-xl px-3.5 text-[15px] font-medium text-fg-2 outline-none transition-colors hover:bg-card-warm hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40";
