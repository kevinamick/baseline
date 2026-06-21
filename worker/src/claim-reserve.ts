import { log } from "./log.js";

export type ClaimDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Ask the app to reserve Points + check the seat cap for a schedule-spawned eval
 * run (#199). The billing decision (price→plan, period math, plan constants, the
 * reserve and seat seams) lives in app TS the worker can't import, so it's reached
 * through the internal `/api/internal/claim-reserve` route, reusing the exact
 * interactive-run logic.
 *
 * Fails CLOSED: an unconfigured secret or any transport/HTTP error refuses the run
 * rather than letting a schedule-spawned run execute unmetered — the schedule just
 * tries again next tick.
 */
export async function claimReserve(runId: string, appUrl: string): Promise<ClaimDecision> {
  const secret = process.env.CLAIM_RESERVE_SECRET;
  if (!secret) {
    log.error("CLAIM_RESERVE_SECRET not set — refusing scheduled run", {
      event: "eval_run.claim_unconfigured",
      run_id: runId,
    });
    return { allowed: false, reason: "billing_unavailable" };
  }
  try {
    const res = await fetch(`${appUrl}/api/internal/claim-reserve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ runId }),
    });
    if (!res.ok) {
      log.error("claim-reserve endpoint returned non-OK", {
        event: "eval_run.claim_endpoint_error",
        run_id: runId,
        status: res.status,
      });
      return { allowed: false, reason: "billing_unavailable" };
    }
    return (await res.json()) as ClaimDecision;
  } catch (err) {
    log.error("claim-reserve request failed", {
      event: "eval_run.claim_request_failed",
      run_id: runId,
      error: err,
    });
    return { allowed: false, reason: "billing_unavailable" };
  }
}

/** User-facing error_message for a claim-time billing refusal (shown on the run detail). */
export function billingBlockedMessage(reason: string): string {
  switch (reason) {
    case "seat_cap":
      return "Run blocked: your team has more members than its plan allows. Remove members or upgrade under Settings → Billing.";
    case "insufficient_points":
      return "Run blocked: your team is out of Eval Points for this period. Raise your overage cap or upgrade under Settings → Billing.";
    case "managed_cap":
      return "Run blocked: this run's estimated managed token spend would take your team past its monthly managed spend cap. Raise the cap, or add your own provider key under Settings → Team.";
    case "managed_not_paid":
      return "Run blocked: Managed Agents are a paid-plan feature. Upgrade under Settings → Billing, or change the schedule's System to an agent that uses your own endpoint.";
    default:
      return "Run blocked: couldn't verify your team's billing. It will retry on the next schedule.";
  }
}
