import "server-only";
import type { EmailMessage } from "./send";
import { invitationEmailHtml } from "./templates/invitation";

/** The accept link for an invitation token, rooted at the app's base URL. */
export function invitationAcceptUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base}/invite/accept?token=${encodeURIComponent(token)}`;
}

/**
 * Builds the invitation email from the imported HTML template. The subject
 * strips newlines from the admin-supplied org name to avoid header injection;
 * the body's escaping lives in the template module.
 */
export function buildInvitationEmail(opts: {
  to: string;
  orgName: string;
  acceptUrl: string;
}): EmailMessage {
  const subject = `You've been invited to ${opts.orgName.replace(/[\r\n]+/g, " ")} on Baseline`;

  return {
    to: opts.to,
    subject,
    html: invitationEmailHtml({ orgName: opts.orgName, acceptUrl: opts.acceptUrl }),
  };
}
