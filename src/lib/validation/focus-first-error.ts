import type { ZodError } from "zod";

/**
 * Scroll to and focus the first element (by id) that exists in the DOM.
 * Pass element ids in the visual/form order you want errors surfaced in;
 * the first one that resolves wins. No-op outside the browser.
 */
export function focusFirstError(ids: string[]): void {
  if (typeof document === "undefined") return;
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      (el as HTMLElement).focus({ preventScroll: true });
      return;
    }
  }
}

/**
 * Turn a ZodError into a Set of dotted path keys (e.g. "rows.0.userInput"),
 * used to drive per-field red borders and inline messages.
 */
export function issuesToInvalidKeys(error: ZodError): Set<string> {
  return new Set(error.issues.map((issue) => issue.path.join(".")));
}
