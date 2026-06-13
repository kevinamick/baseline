import { escapeHtml } from "./escape";
import { EMAIL, ctaButton, wrapEmail } from "./layout";

/**
 * Hard-stop notification (#180): a run was refused because the team's Eval
 * Point balance can't cover it. All interpolations are escaped — the team name
 * is admin-supplied.
 */
export function pointsLimitEmailHtml(opts: {
  teamName: string;
  neededPoints: number;
  remainingPoints: number;
  billingUrl: string;
}): string {
  const team = escapeHtml(opts.teamName);
  const url = escapeHtml(opts.billingUrl);
  const needed = opts.neededPoints.toLocaleString("en-US");
  const remaining = opts.remainingPoints.toLocaleString("en-US");

  const body = `
    <h2 style="${EMAIL.h2}">${team} has hit its Eval Point limit</h2>
    <p style="${EMAIL.p}">An eval run was just blocked: it needs <strong style="${EMAIL.strong}">${needed} Eval Points</strong>, but only <strong style="${EMAIL.strong}">${remaining}</strong> remain in the current billing period.</p>
    <p style="${EMAIL.p}">Runs will start again when the period resets, or sooner on a larger plan.</p>
    ${ctaButton(url, "View usage and billing →")}
  `;

  return wrapEmail({
    previewText: `A run was blocked: it needs ${needed} Eval Points but only ${remaining} remain.`,
    body,
  });
}
