import { escapeHtml } from "./escape";
import { EMAIL, ctaButton, wrapEmail } from "./layout";

/** Format a dollar amount, e.g. 12.5 → "$12.50". */
function fmtUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(amount);
}

/**
 * Managed-token payment-failed notification (#186, ADR-0008 Meter 2). Sent when a
 * threshold-billing invoice for accrued managed token usage is declined: managed
 * runs are paused (fail-closed), but the subscription and BYO-key runs keep
 * working. Recovery is automatic — when the card succeeds (Stripe retry or a
 * manual pay), managed runs resume with no further action. Contributor-facing,
 * throttled once per period. The team name is admin-supplied, so it's escaped.
 */
export function managedPaymentFailedEmailHtml(opts: {
  teamName: string;
  amountUsd: number;
  billingUrl: string;
}): string {
  const team = escapeHtml(opts.teamName);
  const url = escapeHtml(opts.billingUrl);
  const amount = fmtUsd(opts.amountUsd);

  const body = `
    <h2 style="${EMAIL.h2}">${team}: managed token payment failed</h2>
    <p style="${EMAIL.p}">We tried to charge your card for <strong style="${EMAIL.strong}">${amount}</strong> of managed LLM token usage and it was declined. To bound what's owed, managed runs are paused until the payment goes through.</p>
    <p style="${EMAIL.p}">Your subscription is unaffected, and runs using your own provider key (Settings → Team) keep working. Update your card on the Billing page — managed runs resume automatically as soon as the payment succeeds, no further steps needed.</p>
    ${ctaButton(url, "Update payment method →")}
  `;

  return wrapEmail({
    previewText: `Managed token payment of ${amount} was declined — managed runs are paused.`,
    body,
  });
}
