import { escapeHtml } from "./escape";
import { EMAIL, ctaButton, wrapEmail } from "./layout";

/**
 * Execution-time seat re-check (#182): a scheduled downgrade to Free executed
 * while the team still had more members than the Free plan seats. Billing
 * never removes members — it blocks runs until the team resolves it.
 */
export function seatCapEmailHtml(opts: {
  teamName: string;
  memberCount: number;
  seatLimit: number;
  billingUrl: string;
}): string {
  const team = escapeHtml(opts.teamName);
  const url = escapeHtml(opts.billingUrl);

  const body = `
    <h2 style="${EMAIL.h2}">${team} has more members than the Free plan allows</h2>
    <p style="${EMAIL.p}">Your subscription ended while the team still has <strong style="${EMAIL.strong}">${opts.memberCount} members</strong> — the Free plan includes <strong style="${EMAIL.strong}">${opts.seatLimit}</strong>. Runs are paused — both new runs and scheduled ones — until the team fits the plan: remove members, or upgrade to bring everyone along.</p>
    <p style="${EMAIL.p}">No members were removed and no data was deleted.</p>
    ${ctaButton(url, "Manage team and billing →")}
  `;

  return wrapEmail({
    previewText: `Runs are paused: ${team} has ${opts.memberCount} members but Free allows ${opts.seatLimit}.`,
    body,
  });
}
