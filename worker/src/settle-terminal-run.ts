// Unified terminal-outcome seam (#378).
//
// When an Eval Run or an Optimization Run reaches a terminal state, the writers split across
// evalrun/activities.ts and gepa/activities.ts each need to: guard the status transition (so a
// retried/redelivered Activity — or a path racing another terminal writer — can't double-email),
// emit a structured terminal log with org scope, and best-effort email a notification that must
// never fail the transition. `settleTerminalRun` is the one place that sequence lives; the
// writers (completeEvalRun, failEvalRun, markSkipped, failRunQuietly, completeRun, failRun) are
// thin adapters that supply WHAT the outcome is — the guard list, the extra columns to patch, and
// the log/email content. There is nothing to settle financially (ADR-0020: no reservations); the
// name stays for the six call sites and their tests.
//
// The best-effort log + email fire only when THIS call performed the transition.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Single-source enum: which run table this settlement targets. Never duplicate this union —
// derive from RUN_KINDS wherever a run kind is needed.
export const RUN_KINDS = ["eval", "optimization"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

// Single-source enum: the terminal outcomes a run can reach. `skipped` is eval-only (a quiet
// dataset window). Optimization runs only ever end as `completed`/`failed`.
export const TERMINAL_OUTCOMES = ["completed", "failed", "skipped"] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

const TABLE: Record<RunKind, string> = {
  eval: "eval_runs",
  optimization: "optimization_runs",
};

// The actual DB `status` column value for an outcome.
function dbStatus(outcome: TerminalOutcome): "completed" | "failed" | "skipped" {
  return outcome;
}

// Mirrors each writer's pre-existing error message so this refactor is behavior-preserving for
// callers/tests that match on the thrown message (e.g. "Failed to complete eval run: <cause>").
function transitionErrorMessage(kind: RunKind, outcome: TerminalOutcome): string {
  const label = kind === "eval" ? "eval" : "optimization";
  const status = dbStatus(outcome);
  return status === "completed" ? `Failed to complete ${label} run` : `Failed to mark ${label} run ${status}`;
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
  /** Runs immediately after a successful transition, BEFORE `notify`, and is NOT wrapped in the
   * best-effort try/catch below (e.g. failEvalRun's `captureException`) — an error here
   * propagates, matching today's unguarded call. */
  afterTransition?: (row: Row) => void | Promise<void>;
  /** Best-effort terminal notification (structured log + email). Skipped entirely when this
   * call didn't perform the transition (already-terminal — every writer's `if (!flipped)
   * return` today), or when the writer has none at all (the quiet eval markers never notify).
   * A failure anywhere inside `run` is caught and handed to `onError`; the transition has
   * already happened by this point, so notification trouble never fails the terminal Activity. */
  notify?: {
    run: (row: Row) => Promise<void>;
    onError: (err: unknown) => void;
  };
}

// Guard the status transition and — only when THIS call performed the transition — run the
// caller's best-effort terminal notification. Returns whether this call performed the
// transition (mirrors failRunQuietly's pre-existing return contract).
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

  if (!data) return false;

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
