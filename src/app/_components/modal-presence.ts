"use client";

import { useSyncExternalStore } from "react";

/**
 * A tiny global registry of open modals. Modals (the shared `Dialog` shell, and
 * any other full-screen overlay) call `openModal()` on mount and invoke the
 * returned disposer on unmount. Non-modal chrome that must never sit on top of —
 * or compete for clicks with — an open modal subscribes via `useAnyModalOpen()`
 * and steps aside while the count is non-zero. The canonical consumer is the
 * guided first-run coach-mark, which hides its popup and target ring whenever a
 * modal opens and restores them when it closes.
 */

let openCount = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Register an open modal. Returns an idempotent disposer to call on close; it
 * is safe to invoke more than once (only the first call decrements).
 */
export function openModal(): () => void {
  openCount += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCount = Math.max(0, openCount - 1);
    emit();
  };
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): boolean {
  return openCount > 0;
}

// No modals are open during SSR.
function getServerSnapshot(): boolean {
  return false;
}

/** Whether at least one modal is currently open. */
export function useAnyModalOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
