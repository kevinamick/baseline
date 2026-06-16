import "server-only";
import nodemailer from "nodemailer";
import { Resend } from "resend";

/**
 * App-side transactional email. Two transports:
 *
 *   - **Resend** (the same provider the worker uses for run emails) for any real
 *     deployed instance.
 *   - **SMTP to local Mailpit** (`127.0.0.1:54325`) otherwise, so the whole flow
 *     runs detached with no cloud dependency and mail is inspectable in the
 *     Mailpit UI (`127.0.0.1:54324`). Requires `smtp_port = 54325` uncommented
 *     under `[inbucket]` in supabase/config.toml.
 *
 * Transport is Resend in `production` *except* when `EMAIL_TRANSPORT=smtp` forces
 * the local sink. The override exists because the e2e suite serves the
 * **production** bundle (`npm run start`), so `NODE_ENV` alone can't distinguish
 * a real deploy from the test server — and without it billing/invite mail would
 * try Resend with no API key and never reach Mailpit. Real deploys leave
 * `EMAIL_TRANSPORT` unset, preserving the loud throw-on-missing-key behavior.
 */

const FROM = process.env.EMAIL_FROM ?? "Baseline <noreply@baseline.app>";

function useResend(): boolean {
  return process.env.NODE_ENV === "production" && process.env.EMAIL_TRANSPORT !== "smtp";
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail({ to, subject, html }: EmailMessage): Promise<void> {
  if (useResend()) {
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
