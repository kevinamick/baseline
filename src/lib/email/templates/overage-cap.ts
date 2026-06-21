import { escapeHtml } from "./escape";
import { EMAIL, ctaButton, wrapEmail } from "./layout";

/** Format a dollar amount, e.g. 1840 → "$1,840.00". */
function fmtUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(amount);
}

/**
 * Overage Cap notifications (#183). Two stages, both Contributor-facing and
 * throttled once per period via billing_notifications: a warning as committed
 * overage approaches the cap, and the hard stop when a run is refused at it.
 * All interpolations are escaped — the team name is admin-supplied.
 */

export function overageWarningEmailHtml(opts: {
  teamName: string;
  committedUsd: number;
  capUsd: number;
  billingUrl: string;
}): string {
  const team = escapeHtml(opts.teamName);
  const url = escapeHtml(opts.billingUrl);
  const committed = fmtUsd(opts.committedUsd);
  const cap = fmtUsd(opts.capUsd);

  const body = `
    <h2 style="${EMAIL.h2}">${team} is approaching its overage cap</h2>
    <p style="${EMAIL.p}">Your team has used <strong style="${EMAIL.strong}">${committed}</strong> of its <strong style="${EMAIL.strong}">${cap}</strong> monthly overage cap. Runs keep going until the cap is reached; after that, new runs are blocked until the period resets.</p>
    <p style="${EMAIL.p}">You can raise, lower, or turn off the cap any time on the Billing page — the cap is the most overage your team can ever be billed.</p>
    ${ctaButton(url, "View usage and billing →")}
  `;

  return wrapEmail({
    previewText: `${team} has used ${committed} of its ${cap} monthly overage cap.`,
    body,
  });
}

export function overageLimitEmailHtml(opts: {
  teamName: string;
  capUsd: number;
  billingUrl: string;
}): string {
  const team = escapeHtml(opts.teamName);
  const url = escapeHtml(opts.billingUrl);
  const cap = fmtUsd(opts.capUsd);

  const body = `
    <h2 style="${EMAIL.h2}">${team} has reached its overage cap</h2>
    <p style="${EMAIL.p}">A run was just blocked: your team's included usage is exhausted and the <strong style="${EMAIL.strong}">${cap}</strong> monthly overage cap is fully committed. No further overage will be billed.</p>
    <p style="${EMAIL.p}">Runs start again when the period resets — or sooner if a Contributor raises the cap on the Billing page.</p>
    ${ctaButton(url, "View usage and billing →")}
  `;

  return wrapEmail({
    previewText: `A run was blocked — your ${cap} monthly overage cap is fully committed.`,
    body,
  });
}
