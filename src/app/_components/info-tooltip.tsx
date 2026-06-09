"use client";

import { useState, useId } from "react";
import { InfoCircleIcon } from "@/app/_components/icons";

interface InfoTooltipProps {
  content: string;
}

export function InfoTooltip({ content }: InfoTooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
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
          role="tooltip"
          id={id}
          className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-56 -translate-x-1/2 rounded-lg bg-ink px-3 py-2 text-xs leading-relaxed text-fg-on-ink shadow-lg"
        >
          {content}
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-full -translate-x-1/2 border-[5px] border-transparent border-t-ink"
          />
        </span>
      )}
    </span>
  );
}
