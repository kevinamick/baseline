import "server-only";
import nodemailer from "nodemailer";
import { Resend } from "resend";

/**
 * App-side transactional email. Two transports, chosen by `NODE_ENV` — any
 * deployed instance (`production`) uses Resend; everything else is local:
 *
 *   - **production** → Resend (the same provider the worker uses for run emails).
 *   - **otherwise**  → SMTP to local Mailpit (`127.0.0.1:54325`), so the whole
 *     flow runs detached with no cloud dependency and mail is inspectable in the
 *     Mailpit UI (`127.0.0.1:54324`). Requires `smtp_port = 54325` uncommented
 *     under `[inbucket]` in supabase/config.toml.
 */

const FROM = process.env.EMAIL_FROM ?? "Baseline <noreply@baseline.app>";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail({ to, subject, html }: EmailMessage): Promise<void> {
  if (isProduction()) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({ from: FROM, to, subject, html });
    if (error) throw error;
    return;
  }

  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "127.0.0.1",
    port: Number(process.env.SMTP_PORT ?? "54325"),
    secure: false,
  });
  await transport.sendMail({ from: FROM, to, subject, html });
}
