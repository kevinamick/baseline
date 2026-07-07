import { log } from "@/lib/logging/server";
import { requireInternalSecret } from "@/lib/auth/internal-secret";
import { gateScheduledRunBilling } from "@/lib/billing/claim-gate";

/**
 * Claim-time billing gate for schedule-spawned eval runs (#199).
 *
 * The worker POSTs `{ runId }` here right after it claims a scheduled run and its
 * rows are resolved, before the (metered) judging. This route is a thin auth
 * wrapper over `gateScheduledRunBilling`, which runs the SAME reserve + seat-cap
 * logic interactive runs use — so the scheduled path can't drift from it and the
 * worker needs none of the app's billing constants / period math.
 *
 * Authenticated by a shared bearer secret (mirrors /api/internal/managed-threshold).
 * Fails closed: no secret configured → 503; wrong/absent header → 401. The worker,
 * in turn, fails the run closed if this route is unreachable — a scheduled run
 * never runs unmetered.
 */
export async function POST(req: Request): Promise<Response> {
  const denied = requireInternalSecret(req, "CLAIM_RESERVE_SECRET", "eval_run.claim_reserve");
  if (denied) return denied;

  let runId: unknown;
  try {
    ({ runId } = await req.json());
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (typeof runId !== "string" || !runId) {
    return new Response("runId required", { status: 400 });
  }

  let result: Awaited<ReturnType<typeof gateScheduledRunBilling>>;
  try {
    result = await gateScheduledRunBilling(runId);
  } catch (err) {
    await log.error("claim-gate DB error", {
      event: "eval_run.claim_gate_error",
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response("Internal error", { status: 500 });
  }
  if (!result.allowed) {
    await log.info("scheduled run refused at claim", {
      event: "eval_run.claim_refused",
      run_id: runId,
      reason: result.reason,
    });
  }
  return Response.json(result);
}
