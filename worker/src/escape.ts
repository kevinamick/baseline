// HTML-escape worker copy. DUPLICATED from the canonical app-tier source:
//   src/lib/email/templates/escape.ts
// The worker is a separate, independently-Dockerized package (worker/Dockerfile copies only
// `worker/src`), so it cannot import from the app's `src/lib/email/`. This is a deliberate copy —
// keep it in sync with the canonical file. Mirrors the email-layout.ts copy convention.

/** HTML-escape user/tenant-supplied values before template interpolation. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
