import { escapeHtml } from "./escape";

/**
 * Hard-stop notification (#181): an Optimization Run was refused because the
 * Team's per-period allowance is used up.
 */
export function optimizationLimitEmailHtml(opts: {
  teamName: string;
  included: number;
  billingUrl: string;
}): string {
  const team = escapeHtml(opts.teamName);
  const url = escapeHtml(opts.billingUrl);
  const included = opts.included.toLocaleString("en-US");

  return `
    <h2>${team} has used its Optimization Runs for this period</h2>
    <p>An optimization run was just blocked: all <strong>${included}</strong>
    included runs for the current billing period have been used.</p>
    <p>Runs will be available again when the period resets, or sooner on a larger plan.</p>
    <p><a href="${url}">View usage and billing →</a></p>
  `;
}
