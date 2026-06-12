import { escapeHtml } from "./escape";

/**
 * Overage Cap notifications (#183). Two stages, both Contributor-facing and
 * throttled once per period via billing_notifications: a warning as committed
 * overage approaches the cap, and the hard stop when a run is refused at it.
 * All interpolations are escaped — the team name is admin-supplied.
 */

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export function overageWarningEmailHtml(opts: {
  teamName: string;
  committedUsd: number;
  capUsd: number;
  billingUrl: string;
}): string {
  const team = escapeHtml(opts.teamName);
  const url = escapeHtml(opts.billingUrl);

  return `
    <h2>${team} is approaching its overage cap</h2>
    <p>Your team has used <strong>${fmtUsd(opts.committedUsd)}</strong> of its
    <strong>${fmtUsd(opts.capUsd)}</strong> monthly overage cap. Runs keep going
    until the cap is reached; after that, new runs are blocked until the period
    resets.</p>
    <p>You can raise, lower, or turn off the cap any time on the Billing page —
    the cap is the most overage your team can ever be billed.</p>
    <p><a href="${url}">View usage and billing →</a></p>
  `;
}

export function overageLimitEmailHtml(opts: {
  teamName: string;
  capUsd: number;
  billingUrl: string;
}): string {
  const team = escapeHtml(opts.teamName);
  const url = escapeHtml(opts.billingUrl);

  return `
    <h2>${team} has reached its overage cap</h2>
    <p>A run was just blocked: your team's included usage is exhausted and the
    <strong>${fmtUsd(opts.capUsd)}</strong> monthly overage cap is fully
    committed. No further overage will be billed.</p>
    <p>Runs start again when the period resets — or sooner if a Contributor
    raises the cap on the Billing page.</p>
    <p><a href="${url}">View usage and billing →</a></p>
  `;
}