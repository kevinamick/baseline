import { escapeHtml } from "./escape";
import { EMAIL, ctaButton, wrapEmail } from "./layout";

/** Format a dollar amount, e.g. 25 → "$25.00". */
function fmtUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(amount);
}

/**
 * Managed Spend Cap notification (#185, ADR-0008 Meter 2). Contributor-facing,
 * throttled once per period via billing_notifications. Sent when a run is refused
 * because the Team's managed token spend would pass its monthly cap. The team
 * name is admin-supplied, so it's escaped.
 */
export function managedSpendLimitEmailHtml(opts: {
  teamName: string;
  capUsd: number;
  billingUrl: string;
}): string {
  const team = escapeHtml(opts.teamName);
  const url = escapeHtml(opts.billingUrl);
  const cap = fmtUsd(opts.capUsd);

  const body = `
    <h2 style="${EMAIL.h2}">${team} has reached its managed spend cap</h2>
    <p style="${EMAIL.p}">A run was just blocked: your team's managed LLM token spend has reached its <strong style="${EMAIL.strong}">${cap}</strong> monthly cap. Managed token usage is billed at provider cost plus your plan's markup, and this cap is the most your team can spend on it in a month.</p>
    <p style="${EMAIL.p}">Runs start again when the period resets — or sooner if a Contributor raises the cap on the Billing page. Adding your own provider key (Settings → Team) runs on your tokens instead, with no managed spend.</p>
    ${ctaButton(url, "View usage and billing →")}
  `;

  return wrapEmail({
    previewText: `A run was blocked — your ${cap} monthly managed spend cap is reached.`,
    body,
  });
}
