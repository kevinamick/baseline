import { escapeHtml } from "./escape";
import { EMAIL, ctaButton, wrapEmail } from "./layout";

/**
 * Hard-stop notification (#181): an Optimization Run was refused because the
 * team's per-period allowance is exhausted.
 */
export function optimizationLimitEmailHtml(opts: {
  teamName: string;
  included: number;
  billingUrl: string;
}): string {
  const team = escapeHtml(opts.teamName);
  const url = escapeHtml(opts.billingUrl);
  const included = opts.included.toLocaleString("en-US");

  const body = `
    <h2 style="${EMAIL.h2}">${team} has used its Optimization Runs for this period</h2>
    <p style="${EMAIL.p}">An optimization run was just blocked: all <strong style="${EMAIL.strong}">${included}</strong> included runs for the current billing period have been used.</p>
    <p style="${EMAIL.p}">Runs will be available again when the period resets, or sooner on a larger plan.</p>
    ${ctaButton(url, "View usage and billing →")}
  `;

  return wrapEmail({
    previewText: `An optimization run was blocked — all ${included} included runs have been used.`,
    body,
  });
}
