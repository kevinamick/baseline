import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { listOrgMembers, getOrgName } from "@/lib/auth/members";
import { sendEmail } from "@/lib/email/send";
import { log } from "@/lib/logging/server";

/**
 * Send a billing-limit email to a Team's Contributors at most once per billing
 * period (#180/#181). The billing_notifications PK (org, kind, period) is the
 * throttle: only the caller that wins the claim sends. Never throws — a limit
 * refusal must reach the user even when email infrastructure is down.
 */
export async function notifyLimitOnce(opts: {
  orgId: string;
  kind: string;
  periodStart: string;
  subject: (teamName: string) => string;
  html: (teamName: string, billingUrl: string) => string;
}): Promise<void> {
  try {
    const { data: claimed, error: claimError } = await supabaseAdmin
      .from("billing_notifications")
      .upsert(
        { org_id: opts.orgId, kind: opts.kind, period_start: opts.periodStart },
        { onConflict: "org_id,kind,period_start", ignoreDuplicates: true }
      )
      .select("org_id");
    if (claimError) throw claimError;
    if (!claimed || claimed.length === 0) return; // already notified this period

    const [members, teamName] = await Promise.all([
      listOrgMembers(opts.orgId),
      getOrgName(opts.orgId, "Your team"),
    ]);
    const billingUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/settings/billing`;
    const html = opts.html(teamName, billingUrl);
    const subject = opts.subject(teamName);
    await Promise.all(
      members
        .filter((m) => m.role === "admin" && m.email)
        .map((m) => sendEmail({ to: m.email as string, subject, html }))
    );
  } catch (err) {
    await log.error("billing limit email failed", {
      event: "billing.limit_email_failed",
      org_id: opts.orgId,
      kind: opts.kind,
      error: err,
    });
  }
}
