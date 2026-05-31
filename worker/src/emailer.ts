import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const FROM = process.env.RESEND_FROM ?? "evals@baseline.app";

export async function sendCompletionEmail(opts: {
  to: string[];
  runId: string;
  rubricName: string;
  overallScore: number;
  rowCount: number;
  appUrl: string;
}): Promise<void> {
  if (opts.to.length === 0) return;

  const scorePercent = Math.round(opts.overallScore * 100);

  const { error } = await resend.emails.send({
    from: FROM,
    to: opts.to,
    subject: `Eval run complete — ${opts.rubricName} (${scorePercent}%)`,
    html: `
      <p>Your eval run has completed.</p>
      <p><strong>Rubric:</strong> ${escapeHtml(opts.rubricName)}<br>
      <strong>Overall score:</strong> ${scorePercent}%<br>
      <strong>Rows evaluated:</strong> ${opts.rowCount}</p>
      <p><a href="${escapeHtml(opts.appUrl)}/rubrics">View results →</a></p>
    `,
  });
  if (error) throw error;
}

export async function sendFailureEmail(opts: {
  to: string[];
  runId: string;
  rubricName: string;
  errorMessage: string;
  appUrl: string;
}): Promise<void> {
  if (opts.to.length === 0) return;

  const { error } = await resend.emails.send({
    from: FROM,
    to: opts.to,
    subject: `Eval run failed — ${opts.rubricName}`,
    html: `
      <p>Your eval run encountered an error.</p>
      <p><strong>Rubric:</strong> ${escapeHtml(opts.rubricName)}<br>
      <strong>Error:</strong> ${escapeHtml(opts.errorMessage)}</p>
      <p><a href="${escapeHtml(opts.appUrl)}/rubrics">View details →</a></p>
    `,
  });
  if (error) throw error;
}
