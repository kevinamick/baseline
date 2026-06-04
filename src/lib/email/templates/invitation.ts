function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Invitation email body. Both values are escaped — `orgName` is admin-supplied
 * and `acceptUrl` carries a token — so the template is safe to interpolate.
 */
export function invitationEmailHtml(opts: {
  orgName: string;
  acceptUrl: string;
}): string {
  const org = escapeHtml(opts.orgName);
  const url = escapeHtml(opts.acceptUrl);

  return `
    <h2>You've been invited to ${org}</h2>
    <p>You've been invited to join <strong>${org}</strong> on Baseline.</p>
    <p><a href="${url}">Accept your invitation →</a></p>
    <p>This invitation expires in 7 days. If you weren't expecting it, you can
    safely ignore this email.</p>
  `;
}
