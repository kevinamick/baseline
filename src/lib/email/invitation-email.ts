import "server-only";
import type { EmailMessage } from "./send";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The accept link for an invitation token, rooted at the app's base URL. */
export function invitationAcceptUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base}/invite/accept?token=${encodeURIComponent(token)}`;
}

/**
 * Builds the invitation email. `orgName` is admin-supplied, so it's escaped
 * into the HTML body; the subject strips newlines to avoid header injection.
 */
export function buildInvitationEmail(opts: {
  to: string;
  orgName: string;
  acceptUrl: string;
}): EmailMessage {
  const org = escapeHtml(opts.orgName);
  const url = escapeHtml(opts.acceptUrl);
  const subject = `You've been invited to ${opts.orgName.replace(/[\r\n]+/g, " ")} on Baseline`;

  return {
    to: opts.to,
    subject,
    html: `
      <h2>You've been invited to ${org}</h2>
      <p>You've been invited to join <strong>${org}</strong> on Baseline.</p>
      <p><a href="${url}">Accept your invitation →</a></p>
      <p>This invitation expires in 7 days. If you weren't expecting it, you can
      safely ignore this email.</p>
    `,
  };
}
