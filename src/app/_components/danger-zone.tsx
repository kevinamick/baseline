"use client";

import { useState, useId, type ReactNode } from "react";
import { ChevronDownIcon } from "./icons";

/**
 * Expandable disclosure for destructive settings actions. The trigger is
 * intentionally neutral/low-contrast so it doesn't draw the eye; the danger
 * accent color appears only on the final execution button rendered inside the
 * expanded body. The final buttons are not rendered until the user explicitly
 * expands the section.
 */
export function DangerZone({
  triggerLabel,
  children,
}: {
  triggerLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 self-start rounded-full border border-hairline-field px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-card-warm"
      >
        {triggerLabel}
        <ChevronDownIcon
          size={16}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div id={panelId} className="flex flex-col gap-4">
          {children}
        </div>
      )}
    </div>
  );
}
