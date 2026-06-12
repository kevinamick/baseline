function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Hard-stop notification (#180): a run was refused because the Team's Eval
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

  return `
    <h2>${team} has hit its Eval Point limit</h2>
    <p>An eval run was just blocked: it needs <strong>${needed} Eval Points</strong>,
    but <strong>${remaining}</strong> remain in the current billing period.</p>
    <p>Runs will start again when the period resets, or sooner on a larger plan.</p>
    <p><a href="${url}">View usage and billing →</a></p>
  `;
}
