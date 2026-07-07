import "server-only";
import type { EmailMessage } from "./send";
import { invitationEmailHtml } from "./templates/invitation";
import { getEmailTranslator, resolveEmailLocale } from "./i18n";

/** The accept link for an invitation token, rooted at the app's base URL. */
export function invitationAcceptUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base}/invite/accept?token=${encodeURIComponent(token)}`;
}

/**
 * Builds the invitation email in the recipient's resolved locale (#241). The
 * subject strips newlines from the admin-supplied org name to avoid header
 * injection; the body's escaping lives in the template module. `locale` is
 * passed explicitly (emails render off-request) — see resolveEmailLocale.
 */
export async function buildInvitationEmail(opts: {
  to: string;
  orgName: string;
  acceptUrl: string;
  locale: string;
}): Promise<EmailMessage> {
  // Resolve once so the catalog, the document `lang`, and any fallback all agree
  // (an unsupported locale → default for both messages and lang).
  const locale = resolveEmailLocale({ recipientLocale: opts.locale });
  const t = await getEmailTranslator(locale);
  const subject = t("invitation.subject", {
    org: opts.orgName.replace(/[\r\n]+/g, " "),
  });

  return {
    to: opts.to,
    subject,
    html: invitationEmailHtml({
      orgName: opts.orgName,
      acceptUrl: opts.acceptUrl,
      locale,
      t,
    }),
  };
}
