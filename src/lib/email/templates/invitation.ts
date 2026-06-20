import { escapeHtml } from "./escape";
import { EMAIL, ctaButton, wrapEmail } from "./layout";
import type { EmailTranslator } from "../i18n";

/**
 * Invitation email — sent when an org admin invites a new member. Chrome is
 * rendered from the `Email` catalog via the passed locale-bound translator
 * (#241); user/token content is escaped (orgName is admin-supplied, acceptUrl
 * carries a token). The org name is interpolated as a pre-escaped, pre-bolded
 * HTML fragment — `t()` does plain ICU substitution and doesn't re-escape, so
 * the markup survives while the user value stays escaped.
 */
export function invitationEmailHtml(opts: {
  orgName: string;
  acceptUrl: string;
  locale: string;
  t: EmailTranslator;
}): string {
  const { t } = opts;
  const org = escapeHtml(opts.orgName);
  const url = escapeHtml(opts.acceptUrl);
  const orgStrong = `<strong style="${EMAIL.strong}">${org}</strong>`;

  const body = `
    <h2 style="${EMAIL.h2}">${t("invitation.heading", { org })}</h2>
    <p style="${EMAIL.p}">${t("invitation.body", { org: orgStrong })}</p>
    ${ctaButton(url, t("invitation.cta"))}
    <p style="${EMAIL.p};margin-top:20px;">${t("invitation.expiry")}</p>
  `;

  return wrapEmail({
    previewText: t("invitation.preview", { org }),
    body,
    lang: opts.locale,
    footerText: t("layout.footer"),
    questionsLabel: t("layout.questions"),
  });
}
