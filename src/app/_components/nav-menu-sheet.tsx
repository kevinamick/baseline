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

  // Return focus to the trigger whenever the sheet closes — by Escape, an outside
  // tap (the scrim), a link/button inside it, or the breakpoint auto-close — so
  // focus never strands on a removed element behind the locked-scroll scrim.
  // Done in an effect (refs may only be read outside render; `close` is handed to
  // children during render, so it can't touch the ref itself).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const FOCUSABLE =
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false); // the open-watcher effect restores focus to the trigger
        return;
      }
      // Trap Tab within the panel: the scrim + scroll lock make this a modal
      // surface, so focus shouldn't walk out to the page behind it.
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panelRef.current.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    // Auto-close if the viewport grows past the menu breakpoint (the trigger is
    // hidden there, so an open sheet would otherwise have no way to dismiss).
    const mq = window.matchMedia(`(min-width: ${closeAbovePx}px)`);
    const onChange = () => {
      if (mq.matches) setOpen(false);
    };

    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
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
          {/* Not role="menu": the rows are links and form-wrapped buttons, not
              roving menuitems — matching the app's other popovers (AccountMenu).
              The labelled trigger (aria-expanded/-controls) carries the
              affordance. No px-safe here: it would override p-2's side padding to
              the (portrait: 0) inset; inset-x-3 already clears the screen edges. */}
          <div
            ref={panelRef}
            id={panelId}
            aria-label={label}
            className="sheet-panel-in fixed inset-x-3 top-[72px] z-50 flex max-h-[calc(100dvh-88px)] flex-col gap-1 overflow-y-auto rounded-2xl border border-hairline-cool bg-paper-soft p-2 pb-safe-plus shadow-xl"
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
