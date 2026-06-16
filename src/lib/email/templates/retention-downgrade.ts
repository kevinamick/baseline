import { escapeHtml } from "./escape";
import { EMAIL, ctaButton, wrapEmail } from "./layout";

/** Format an ISO date as "June 15, 2026". */
function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

/**
 * Downgrade-cliff notification (#187, ADR-0008). Sent when a plan change shrinks
 * the Retention Window and bulk-soft-deletes run history that fell outside it. The
 * loud treatment ADR-0008 calls for: the affected count and the purge date, plus
 * the recovery path — re-upgrading within the 30-day grace restores everything not
 * yet purged. Nothing is deleted yet; permanent deletion only happens via the
 * scheduled purge job, never as a side effect of this change. Contributor-facing,
 * throttled once per period. The team name is admin-supplied, so it's escaped.
 */
export function retentionDowngradeEmailHtml(opts: {
  teamName: string;
  planName: string;
  retentionDays: number;
  runCount: number;
  purgeDateIso: string;
  billingUrl: string;
}): string {
  const team = escapeHtml(opts.teamName);
  const plan = escapeHtml(opts.planName);
  const url = escapeHtml(opts.billingUrl);
  const date = fmtDate(opts.purgeDateIso);
  const runs = `${opts.runCount} ${opts.runCount === 1 ? "run" : "runs"}`;
  const verb = opts.runCount === 1 ? "is" : "are";

  const body = `
    <h2 style="${EMAIL.h2}">${team}: ${runs} moved out of your retention window</h2>
    <p style="${EMAIL.p}">Your plan is now <strong style="${EMAIL.strong}">${plan}</strong>, which keeps the last <strong style="${EMAIL.strong}">${opts.retentionDays} days</strong> of run history. ${runs} older than that ${verb} now hidden from your team.</p>
    <p style="${EMAIL.p}">Nothing has been deleted. This history is permanently purged on <strong style="${EMAIL.strong}">${date}</strong>. Re-upgrade before then and every run back inside your window is restored automatically — no support ticket needed.</p>
    ${ctaButton(url, "View plans and billing →")}
  `;

  return wrapEmail({
    previewText: `${runs} ${verb} now hidden — permanently deleted on ${date} unless you re-upgrade.`,
    body,
  });
}
