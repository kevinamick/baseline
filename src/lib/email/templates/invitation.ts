import { escapeHtml } from "./escape";
import { EMAIL, ctaButton, wrapEmail } from "./layout";

/**
 * Invitation email — sent when an org admin invites a new member.
 * Both values are escaped: orgName is admin-supplied, acceptUrl carries a token.
 */
export function invitationEmailHtml(opts: {
  orgName: string;
  acceptUrl: string;
}): string {
  const org = escapeHtml(opts.orgName);
  const url = escapeHtml(opts.acceptUrl);

  const body = `
    <h2 style="${EMAIL.h2}">You've been invited to ${org}</h2>
    <p style="${EMAIL.p}">You've been invited to join <strong style="${EMAIL.strong}">${org}</strong> on Baseline.</p>
    ${ctaButton(url, "Accept invitation →")}
    <p style="${EMAIL.p};margin-top:20px;">This invitation expires in 7&nbsp;days. If you weren't expecting it, you can safely ignore this email.</p>
  `;

  return wrapEmail({
    previewText: `${org} has invited you to join their team on Baseline.`,
    body,
  });
}
