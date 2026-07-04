// Unified terminal-outcome settlement seam (#378, ADR-0009's code-level home).
//
// When an Eval Run or an Optimization Run reaches a terminal state, six call sites split
// across evalrun/activities.ts and gepa/activities.ts each independently had to: guard the
// status transition (so a retried/redelivered Activity — or a path racing another terminal
// writer — can't double-settle or double-email), settle the run's Point reservation (or, for
// an Optimization Run, its allowance unit + points) with the RPC that matches its kind, release
// the managed-spend reservation (verbatim duplicated per kind before this module existed), emit
// a structured terminal log with org scope, and best-effort email a notification that must
// never fail the settlement. `settleTerminalRun` is the one place that sequence lives; the six
// writers (completeEvalRun, failEvalRun, markSkipped, markBillingBlocked/failRunQuietly,
// completeRun, failRun) become thin adapters that supply WHAT the outcome is — the guard list,
// the extra columns to patch, and the log/email content — while this module owns what a
// terminal outcome MEANS (the sequence itself).
//
// Settlement always runs against the run's REAL terminal status, not necessarily the outcome
// this call was asked for: when the guarded UPDATE below doesn't match (another attempt, or
// another terminal path, already owns the transition), we read the row's actual status and
// settle THAT — a crash between an earlier attempt's flip and its settle must not strand the
// reservation. The best-effort log + email fire only when THIS call performed the transition.

import { createClient } from "@supabase/supabase-js";
import { log } from "./log.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Single-source enum: which run table this settlement targets. Never duplicate this union —
// derive from RUN_KINDS wherever a run kind is needed.
export const RUN_KINDS = ["eval", "optimization"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

// Single-source enum: the terminal outcomes a run can settle as. `skipped` is eval-only (a
// quiet dataset window). `billing_blocked` is also eval-only (the claim-time reserve gate
// refusal, #199) and persists as the same 'failed' DB status as a plain failure — there was no
// distinct persisted state for it before this module existed either, and it carries no
// notification (matching the pre-existing markBillingBlocked/failRunQuietly contract).
// Optimization runs only ever settle as `completed`/`failed`.
export const TERMINAL_OUTCOMES = ["completed", "failed", "skipped", "billing_blocked"] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

const TABLE: Record<RunKind, string> = {
  eval: "eval_runs",
  optimization: "optimization_runs",
};

// The DB statuses that count as terminal per kind — used to settle with the run's REAL status
// when this call didn't itself perform the transition.
const TERMINAL_STATUSES: Record<RunKind, ReadonlySet<string>> = {
  eval: new Set(["completed", "failed", "skipped"]),
  optimization: new Set(["completed", "failed"]),
};

// The actual DB `status` column value for an outcome. `billing_blocked` has no distinct status
// of its own — it's recorded as `failed`, same as any other failure.
function dbStatus(outcome: TerminalOutcome): "completed" | "failed" | "skipped" {
  return outcome === "billing_blocked" ? "failed" : outcome;
}

// Mirrors each writer's pre-existing error message so this refactor is behavior-preserving for
// callers/tests that match on the thrown message (e.g. "Failed to complete eval run: <cause>").
function transitionErrorMessage(kind: RunKind, outcome: TerminalOutcome): string {
  const label = kind === "eval" ? "eval" : "optimization";
  const status = dbStatus(outcome);
  return status === "completed" ? `Failed to complete ${label} run` : `Failed to mark ${label} run ${status}`;
}

async function currentTerminalStatus(kind: RunKind, runId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from(TABLE[kind])
    .select("status")
    .eq("id", runId)
    .maybeSingle<{ status: string }>();
  // Message matches the pre-existing eval-only terminalStatusOf's wording exactly (no run-kind
  // ever qualified it there, and eval callers/tests match on this literal string).
  if (error) throw new Error(`Failed to read run status: ${error.message}`);
  const status = data?.status;
  return status && TERMINAL_STATUSES[kind].has(status) ? status : null;
}

// ---- settlement RPCs (the "correct settle RPC per run kind") ----

async function settleEvalPoints(
  runId: string,
  outcome: "completed" | "failed" | "skipped",
  mustSucceed: boolean
): Promise<void> {
  const { error } = await supabase.rpc("settle_eval_run_points", {
    p_run_id: runId,
    p_outcome: outcome,
  });
  if (error) {
    log.error("Point settlement failed", {
      event: "eval_run.settle_failed",
      run_id: runId,
      outcome,
      error,
    });
    if (mustSucceed) throw new Error(`Point settlement failed: ${error.message}`);
  }
}

async function settleOptimizationAllowance(
  runId: string,
  outcome: "completed" | "failed",
  mustSucceed: boolean
): Promise<void> {
  const { error } = await supabase.rpc("settle_optimization_run", { p_run_id: runId });
  if (error) {
    log.error("Allowance settlement failed", {
      event: "optimization_run.settle_failed",
      opt_run_id: runId,
      error,
    });
    if (mustSucceed) throw new Error(`Allowance settlement failed: ${error.message}`);
  }
  // Settle the Eval Point reservation to the rollouts actually scored (ADR-0016).
  const { error: ptErr } = await supabase.rpc("settle_optimization_run_points", {
    p_run_id: runId,
    p_outcome: outcome,
  });
  if (ptErr) {
    log.error("Optimization point settlement failed", {
      event: "optimization_run.points_settle_failed",
      opt_run_id: runId,
      error: ptErr,
    });
    if (mustSucceed) throw new Error(`Optimization point settlement failed: ${ptErr.message}`);
  }
}

// The ONE place `release_managed_reservation` is called from across the worker's terminal
// paths (#378 — it was duplicated verbatim per run kind before this module existed).
async function releaseManagedReservation(
  kind: RunKind,
  runId: string,
  mustSucceed: boolean
): Promise<void> {
  const { error } = await supabase.rpc("release_managed_reservation", {
    p_eval_run_id: kind === "eval" ? runId : null,
    p_opt_run_id: kind === "optimization" ? runId : null,
  });
  if (error) {
    log.error("Managed reservation release failed", {
      event: "managed_spend.release_failed",
      ...(kind === "eval" ? { run_id: runId } : { opt_run_id: runId }),
      error,
    });
    if (mustSucceed) throw new Error(`Managed reservation release failed: ${error.message}`);
  }
}

async function settle(
  kind: RunKind,
  runId: string,
  status: "completed" | "failed" | "skipped",
  mustSucceed: boolean
): Promise<void> {
  if (kind === "eval") {
    await settleEvalPoints(runId, status, mustSucceed);
  } else {
    await settleOptimizationAllowance(runId, status as "completed" | "failed", mustSucceed);
  }
  await releaseManagedReservation(kind, runId, mustSucceed);
}

// ---- the seam ----

export interface SettleTerminalRunInput<Row extends Record<string, unknown> = Record<string, unknown>> {
  runKind: RunKind;
  runId: string;
  outcome: TerminalOutcome;
  /** Statuses the run must currently hold for this write to take effect — the guarded
   * transition (e.g. `["running"]` for a normal completion, `["queued", "running"]` for a
   * failure that can strike before or during execution). A call whose write matches none of
   * these is a no-op here (another attempt/path already owns the transition); settlement still
   * runs against the run's REAL terminal status, but the log/email below is skipped. */
  fromStatuses: readonly string[];
  /** Extra columns for the transition UPDATE beyond `status`/`updated_at`. */
  patch?: Record<string, unknown>;
  /** Columns the guarded UPDATE's own `.select()` should return, beyond the default `"id"` —
   * e.g. `"created_at, org_id"` so a caller can read back the row's org (for the ambient
   * log-context patch) and creation time (for the terminal log's `duration_ms`) in the same
   * round trip, without a second query. */
  selectColumns?: string;
  /** Whether a settlement RPC failure THROWS (so Temporal retries the whole Activity) instead
   * of logging-and-continuing. `true` for eval's completeEvalRun/failEvalRun; `false` (default)
   * everywhere else — gepa's settlement and eval's mid-run skip/billing-block markers — matching
   * each writer's pre-existing contract. */
  settleMustSucceed?: boolean;
  /** Runs immediately after a successful transition, BEFORE `notify`, and is NOT wrapped in the
   * best-effort try/catch below (e.g. failEvalRun's `captureException`) — an error here
   * propagates, matching today's unguarded call. */
  afterTransition?: (row: Row) => void | Promise<void>;
  /** Best-effort terminal notification (structured log + email). Skipped entirely when this
   * call didn't perform the transition (already-terminal — every writer's `if (!flipped)
   * return` today), or when the writer has none at all (the quiet eval markers never notify).
   * A failure anywhere inside `run` is caught and handed to `onError`; settlement has already
   * happened by this point, so notification trouble never fails the terminal Activity. */
  notify?: {
    run: (row: Row) => Promise<void>;
    onError: (err: unknown) => void;
  };
}

// Guard the status transition, settle the run's reservation(s) with the outcome's real DB
// status, release the managed-spend reservation, and — only when THIS call performed the
// transition — run the caller's best-effort terminal notification. Returns whether this call
// performed the transition (mirrors failRunQuietly's pre-existing return contract).
export async function settleTerminalRun<
  Row extends Record<string, unknown> = Record<string, unknown>
>(input: SettleTerminalRunInput<Row>): Promise<boolean> {
  const {
    runKind,
    runId,
    outcome,
    fromStatuses,
    patch,
    selectColumns,
    settleMustSucceed = false,
    afterTransition,
    notify,
  } = input;

  const { data, error } = await supabase
    .from(TABLE[runKind])
    .update({ status: dbStatus(outcome), updated_at: new Date().toISOString(), ...patch })
    .eq("id", runId)
    .in("status", fromStatuses)
    .select(selectColumns ?? "id")
    .maybeSingle<Row>();
  if (error) throw new Error(`${transitionErrorMessage(runKind, outcome)}: ${error.message}`);

  const transitioned = Boolean(data);
  const settleStatus = transitioned ? dbStatus(outcome) : await currentTerminalStatus(runKind, runId);
  if (settleStatus) {
    await settle(runKind, runId, settleStatus as "completed" | "failed" | "skipped", settleMustSucceed);
  }

  if (!transitioned) return false;

  if (afterTransition) await afterTransition(data as Row);

  if (notify) {
    try {
      await notify.run(data as Row);
    } catch (err) {
      notify.onError(err);
    }
  }

  return true;
}
