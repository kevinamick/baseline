import { escapeHtml } from "./escape";

/**
 * Execution-time seat re-check (#182): a scheduled downgrade to Free executed
 * while the Team still had more members than the Free plan seats. Billing
 * never removes members — it blocks runs until the Team resolves it.
 */
export function seatCapEmailHtml(opts: {
  teamName: string;
  memberCount: number;
  seatLimit: number;
  billingUrl: string;
}): string {
  const team = escapeHtml(opts.teamName);
  const url = escapeHtml(opts.billingUrl);

  return `
    <h2>${team} has more members than the Free plan allows</h2>
    <p>Your subscription ended while the team still has
    <strong>${opts.memberCount} members</strong> — the Free plan includes
    <strong>${opts.seatLimit}</strong>. Runs are paused until the team fits the
    plan: remove members, or upgrade to bring everyone along. No members were
    removed and no data was deleted.</p>
    <p><a href="${url}">View usage and billing →</a></p>
  `;
}
