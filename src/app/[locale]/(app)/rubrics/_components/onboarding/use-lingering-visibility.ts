"use client";

import { useDeferredValue } from "react";

/**
 * Returns true while `live` is true, and keeps returning true for the single
 * render in which `live` has just flipped to false — so a surface whose
 * visibility is derived from live data lingers through the current render and
 * falls away only on the NEXT render (after data revalidation), instead of
 * vanishing optimistically the instant the data flips.
 *
 * `useDeferredValue` lags its input by a render: on the render where `live`
 * becomes false it still reflects the previous (true) value, then React commits
 * a follow-up render with the settled value. ORing the live and deferred values
 * shows the surface immediately when it becomes active and hides it only once
 * both the current and the deferred reading agree it should be gone.
 */
export function useLingeringVisibility(live: boolean): boolean {
  const deferred = useDeferredValue(live);
  return live || deferred;
}
