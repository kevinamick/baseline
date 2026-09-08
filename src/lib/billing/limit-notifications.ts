import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { pointsLimitEmailHtml } from "@/lib/email/templates/points-limit";
import {
  overageLimitEmailHtml,
  overageWarningEmailHtml,
} from "@/lib/email/templates/overage-cap";
import { managedSpendLimitEmailHtml } from "@/lib/email/templates/managed-spend";
import { managedPaymentFailedEmailHtml } from "@/lib/email/templates/managed-payment-failed";
import { optimizationLimitEmailHtml } from "@/lib/email/templates/optimization-limit";
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

    // The Local Workspace has no member addresses (ADR-0020): the throttle row
    // is still claimed so the refusal is recorded once per period, but there
    // is nobody to email. Billing itself leaves with #526.
    void sendEmail;
  } catch (err) {
    await log.error("billing limit email failed", {
      event: "billing.limit_email_failed",
      org_id: opts.orgId,
      kind: opts.kind,
      error: err,
    });
  }
}

// ---------- Kind-keyed template registry (#386) ----------
//
// Before this registry, each billing-limit email was a separate hand-built
// wrapper picking a bare kind string and closing over its own subject/html —
// five of them (points cap, overage cap, near-cap warning, managed cap,
// managed payment failed), plus the optimization run-start action bypassing
// wrappers entirely with two INLINE copies of the "optimization_runs_limit"
// closure (once per meter branch: allowance-unit exhausted, and points
// exhausted). Two copies had already drifted apart from the "owned once"
// intent the wrapper comment promised. Every kind's subject/body construction
// now lives in exactly one place, `NOTIFICATION_TEMPLATES` below, and
// `notifyBillingLimit` is the one function that turns a kind + its params
// into a `notifyLimitOnce` call — no caller builds a subject/html closure by
// hand anymore.
//
// The five original wrapper functions (notifyPointsLimitOnce here,
// notifyCapReached/maybeWarnNearCap in overage.ts, notifyManagedCapReached/
// notifyManagedPaymentFailed in managed-spend.ts) still exist as thin,
// call-site-compatible delegators to notifyBillingLimit — the scheduled claim
// gate (src/lib/billing/claim-gate.ts) and the Stripe webhook route call them
// by name today and are out of this change's surgical scope, so their public
// shape is preserved even though none of them constructs a closure anymore.

/** Every billing-limit email kind. Single source: widen here, not by string literal at a call site. */
export const NOTIFICATION_KIND = {
  pointsLimit: "points_limit",
  overageLimit: "overage_limit",
  overageWarning: "overage_warning",
  managedSpendLimit: "managed_spend_limit",
  managedPaymentFailed: "managed_payment_failed",
  optimizationRunsLimit: "optimization_runs_limit",
} as const;
export type NotificationKind = (typeof NOTIFICATION_KIND)[keyof typeof NOTIFICATION_KIND];

/** Per-kind params beyond teamName/billingUrl, which notifyLimitOnce always supplies. */
export interface NotificationParams {
  points_limit: { neededPoints: number; remainingPoints: number };
  overage_limit: { capUsd: number };
  overage_warning: { committedUsd: number; capUsd: number };
  managed_spend_limit: { capUsd: number };
  managed_payment_failed: { amountUsd: number };
  optimization_runs_limit: { included: number };
}

interface NotificationTemplate<K extends NotificationKind> {
  subject: (teamName: string) => string;
  html: (teamName: string, billingUrl: string, params: NotificationParams[K]) => string;
}

/**
 * The registry: one row per NotificationKind. A `Record<NotificationKind, …>`
 * so adding a kind to NOTIFICATION_KIND without a template here fails to
 * typecheck (the single-source-enum guarantee, see AGENTS.md). Exported only
 * for the registry-completeness test — production code sends exclusively
 * through notifyBillingLimit below.
 */
export const NOTIFICATION_TEMPLATES: { [K in NotificationKind]: NotificationTemplate<K> } = {
  [NOTIFICATION_KIND.pointsLimit]: {
    subject: (teamName) => `${teamName} has hit its Eval Point limit`,
    html: (teamName, billingUrl, params) =>
      pointsLimitEmailHtml({
        teamName,
        neededPoints: params.neededPoints,
        remainingPoints: params.remainingPoints,
        billingUrl,
      }),
  },
  [NOTIFICATION_KIND.overageLimit]: {
    subject: (teamName) => `${teamName} has reached its overage cap`,
    html: (teamName, billingUrl, params) =>
      overageLimitEmailHtml({ teamName, capUsd: params.capUsd, billingUrl }),
  },
  [NOTIFICATION_KIND.overageWarning]: {
    subject: (teamName) => `${teamName} is approaching its overage cap`,
    html: (teamName, billingUrl, params) =>
      overageWarningEmailHtml({
        teamName,
        committedUsd: params.committedUsd,
        capUsd: params.capUsd,
        billingUrl,
      }),
  },
  [NOTIFICATION_KIND.managedSpendLimit]: {
    subject: (teamName) => `${teamName} has reached its managed spend cap`,
    html: (teamName, billingUrl, params) =>
      managedSpendLimitEmailHtml({ teamName, capUsd: params.capUsd, billingUrl }),
  },
  [NOTIFICATION_KIND.managedPaymentFailed]: {
    subject: (teamName) => `${teamName}: managed token payment failed`,
    html: (teamName, billingUrl, params) =>
      managedPaymentFailedEmailHtml({ teamName, amountUsd: params.amountUsd, billingUrl }),
  },
  [NOTIFICATION_KIND.optimizationRunsLimit]: {
    subject: (teamName) => `${teamName} has used its Optimization Runs for this period`,
    html: (teamName, billingUrl, params) =>
      optimizationLimitEmailHtml({ teamName, included: params.included, billingUrl }),
  },
};

/**
 * The one entry point for every billing-limit email (#386): look up the
 * kind's template and send it through notifyLimitOnce's once-per-period
 * throttle. `params` is typed to the given `kind` (NotificationParams[K]), so
 * passing the wrong shape for a kind fails to typecheck. Never throws —
 * notifyLimitOnce itself is best-effort.
 */
export async function notifyBillingLimit<K extends NotificationKind>(
  kind: K,
  orgId: string,
  periodStart: string,
  params: NotificationParams[K]
): Promise<void> {
  const template = NOTIFICATION_TEMPLATES[kind];
  await notifyLimitOnce({
    orgId,
    kind,
    periodStart,
    subject: template.subject,
    html: (teamName, billingUrl) => template.html(teamName, billingUrl, params),
  });
}

/**
 * Send the "hit your Eval Point limit" email once per period. Both the interactive
 * reserve path (createEvalRun) and the scheduled claim gate (gateScheduledRunBilling)
 * refuse an underfunded run with identical copy, so the notifyLimitOnce shape lives
 * here once instead of being copy-pasted at each call site.
 */
export async function notifyPointsLimitOnce(opts: {
  orgId: string;
  periodStart: string;
  neededPoints: number;
  remainingPoints: number;
}): Promise<void> {
  await notifyBillingLimit(NOTIFICATION_KIND.pointsLimit, opts.orgId, opts.periodStart, {
    neededPoints: opts.neededPoints,
    remainingPoints: opts.remainingPoints,
  });
}
