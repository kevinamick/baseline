import { Resend } from "resend";

// Construct the Resend client lazily: the v4 SDK throws on a missing key at construction, so a
// module-load `new Resend()` would crash any importer in environments without RESEND_API_KEY —
// including local dev, where the dev SMTP path (below) needs no key at all. Deferring to first
// Resend send keeps import side-effect-free.
let resend: Resend | undefined;
function client(): Resend {
  return (resend ??= new Resend(process.env.RESEND_API_KEY));
}

const FROM = process.env.RESEND_FROM ?? "evals@baseline.app";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Dev-only transport gate. When MAILPIT_SMTP_HOST is set, worker transactional mail routes to the
// local Mailpit instance over SMTP instead of Resend, so eval-run and optimization emails are
// inspectable in the Mailpit UI (127.0.0.1:54324) and never bounce real seed/test recipients off
// the real Resend account. Production never sets this, so it stays on Resend with the real key.
function mailpitHost(): string | undefined {
  return process.env.MAILPIT_SMTP_HOST;
}

async function deliverViaMailpit(
  to: string[],
  subject: string,
  html: string,
  host: string
): Promise<void> {
  let nodemailer: (typeof import("nodemailer"))["default"];
  try {
    ({ default: nodemailer } = await import("nodemailer"));
  } catch {
    throw new Error(
      "MAILPIT_SMTP_HOST is set but nodemailer is not installed. " +
        "nodemailer is a devDependency for the local Mailpit dev path only. " +
        "Unset MAILPIT_SMTP_HOST in production so mail routes through Resend."
    );
  }
  const transport = nodemailer.createTransport({
    host,
    port: Number(process.env.MAILPIT_SMTP_PORT ?? "54325"),
    secure: false,
  });
  await transport.sendMail({ from: FROM, to, subject, html });
}

/**
 * Shared transactional-email send for the worker (eval-run emails here + optimization emails in
 * optimization-emailer.ts). Routes to local Mailpit over SMTP in dev (MAILPIT_SMTP_HOST set) and to
 * Resend everywhere else. A throw on the Resend path propagates so the caller can log it; the empty
 * recipient list is a no-op on both transports.
 */
export async function deliver(to: string[], subject: string, html: string): Promise<void> {
  if (to.length === 0) return;

  const host = mailpitHost();
  if (host) {
    await deliverViaMailpit(to, subject, html, host);
    return;
  }

  const { error } = await client().emails.send({ from: FROM, to, subject, html });
  if (error) throw error;
}

export async function sendCompletionEmail(opts: {
  to: string[];
  runId: string;
  rubricName: string;
  overallScore: number;
  rowCount: number;
  appUrl: string;
}): Promise<void> {
  const scorePercent = Math.round(opts.overallScore * 100);

  await deliver(
    opts.to,
    `Eval run complete — ${opts.rubricName} (${scorePercent}%)`,
    `
      <p>Your eval run has completed.</p>
      <p><strong>Rubric:</strong> ${escapeHtml(opts.rubricName)}<br>
      <strong>Overall score:</strong> ${scorePercent}%<br>
      <strong>Rows evaluated:</strong> ${opts.rowCount}</p>
      <p><a href="${escapeHtml(opts.appUrl)}/rubrics">View results →</a></p>
    `
  );
}

export async function sendFailureEmail(opts: {
  to: string[];
  runId: string;
  rubricName: string;
  errorMessage: string;
  appUrl: string;
}): Promise<void> {
  await deliver(
    opts.to,
    `Eval run failed — ${opts.rubricName}`,
    `
      <p>Your eval run encountered an error.</p>
      <p><strong>Rubric:</strong> ${escapeHtml(opts.rubricName)}<br>
      <strong>Error:</strong> ${escapeHtml(opts.errorMessage)}</p>
      <p><a href="${escapeHtml(opts.appUrl)}/rubrics">View details →</a></p>
    `
  );
}
