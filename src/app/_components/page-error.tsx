"use client";

import { NavBarSkeleton } from "@/app/_components/page-skeleton";

/**
 * Shared error-page surface for App Router `error.tsx` boundaries.
 *
 * Mirrors the outer chrome of `PageSkeleton` (nav placeholder + page surface)
 * so the chrome stays stable on error without needing auth context. The
 * `reset` callback is wired to the "Try again" button — it re-renders the
 * route segment so a transient error (expired session, momentary DB blip)
 * can be recovered without a full reload.
 */
export function PageError({
  reset,
  width = "wide",
}: {
  reset: () => void;
  width?: "wide" | "narrow";
}) {
  return (
    <div
      className={
        width === "wide"
          ? "flex min-h-screen flex-col bg-paper bg-paper-gradient"
          : "flex min-h-screen flex-col bg-paper"
      }
    >
      <NavBarSkeleton />
      {width === "wide" ? (
        <div className="mx-auto w-full max-w-[1360px] flex-1 px-6 pb-6">
          <ErrorCard reset={reset} />
        </div>
      ) : (
        <main className="mx-auto w-full max-w-2xl flex-1 p-6">
          <ErrorCard reset={reset} />
        </main>
      )}
    </div>
  );
}

function ErrorCard({ reset }: { reset: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
      <p className="text-sm font-medium text-fg-2">Something went wrong</p>
      <p className="mt-1 text-xs text-fg-3">
        A temporary error occurred loading this page.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-5 rounded-full bg-ink px-5 py-2 text-sm font-medium text-fg-on-ink outline-none transition-colors hover:bg-ink-hover focus-visible:ring-[3px] focus-visible:ring-accent/40"
      >
        Try again
      </button>
    </div>
  );
}
