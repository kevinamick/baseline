"use server";

import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { EvalRunInputSchema } from "@/lib/validation/schemas";
import { evalRunPointCost, evalRunPointsPerRow } from "@/lib/billing/points";
import { reserveEvalRunPoints } from "@/lib/billing/ledger";
import { notifyLimitOnce } from "@/lib/billing/limit-notifications";
import { getSeatCapState, seatCapError } from "@/lib/billing/seats";
import { maybeWarnNearCap, notifyCapReached } from "@/lib/billing/overage";
import {
  evalRunBlockedForMissingKey,
  managedRunBlockedForPayment,
  resolveKeyModeForEstimate,
  KEY_MODE,
} from "@/lib/llm/key-gate";
import { estimateManagedSpendUsd } from "@/lib/billing/managed-spend-estimate";
import {
  getEffectiveManagedCap,
  reserveManagedSpend,
  notifyManagedCapReached,
} from "@/lib/billing/managed-spend";
import { ESTIMATE_JUDGE_MODEL, ESTIMATE_JUDGE_PROVIDER } from "@/lib/llm/model-prices";
import { PLANS } from "@/lib/billing/plans";
import { fmtRate, fmtUsd } from "@/lib/billing/format";
import { pointsLimitEmailHtml } from "@/lib/email/templates/points-limit";
import type { EvalRun, EvalRunComparison, EvalRunDetails, EvalRunRow, RunComparisonSide } from "@/types/eval-run";

// Cap the rubric run-history list. getEvalRuns is polled every 5s while a run is
// active (runs-panel.tsx) and a scheduled rubric accumulates runs indefinitely,
// so the unbounded whole-history read+render is the hottest growth surface here.
// The most-recent window is all the panel needs: the active run and the >=2
// completed runs the compare affordance gates on are always newest-first, and the
// list already shows a retention note (#187). Mirrors the schedules run-history
// .limit(50) on the same eval_runs table; larger here since this is the primary
// browse/compare surface.
const RUBRIC_RUNS_DISPLAY_LIMIT = 100;

// ---------- Create ----------

export interface InsufficientPoints {
  needed: number;
  remaining: number;
}

/**
 * Roll a half-created run back: release its reservation ('skipped' settles 0
 * and releases everything), then delete the row. The settle must land first —
 * the delete nulls the ledger FK, after which the reservation is unfindable.
 * If the settle fails, the run row is LEFT IN PLACE: the reaper fails queued
 * runs with no queue message and sweep-settles them, so the points self-heal
 * within minutes instead of stranding for the period.
 */
async function rollBackRun(runId: string, orgId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("settle_eval_run_points", {
    p_run_id: runId,
    p_outcome: "skipped",
  });
  if (error) {
    await log.error("reservation release failed — leaving the run for the reaper to settle", {
      event: "eval_run.reservation_release_failed",
      run_id: runId,
      org_id: orgId,
      error,
    });
    return;
  }
  await supabaseAdmin.from("eval_runs").delete().eq("id", runId);
}

export async function createEvalRun(
  rubricId: string,
  rows: EvalRunRow[],
  opts: {
    description?: string;
    notificationEmails?: string[];
    inputSource: string;
  }
): Promise<
  | { runId: string }
  | { error: string; insufficientPoints?: InsufficientPoints }
> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (!canWrite) return { error: "Only contributors can run evaluations" };

  const parsed = EvalRunInputSchema.safeParse({ rubricId, rows });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // Seat-cap gate (#182): a Team over its plan's seats — e.g. a downgrade to
  // Free executed while members remained — is fail-closed until it fits.
  // Billing never removes members; it only blocks activity.
  const seats = await getSeatCapState(orgId);
  if (seats.violated) {
    return { error: seatCapError(seats, "run evals") };
  }

  // BYO-key gate (#184): a Free Team has no managed-key fallback, so it must have
  // its own provider key on file or its runs fail closed. Paid Teams fall back to
  // the managed platform key and pass straight through. Checked before the run is
  // created so a keyless Free Team gets an immediate, inline refusal.
  if (await evalRunBlockedForMissingKey(orgId)) {
    return {
      error:
        "Add an LLM provider key to run: the Free plan uses your own provider key. Add one under Settings → Team.",
    };
  }

  // Managed-payment fail-closed gate (#186, ADR-0008 Meter 2). A declined
  // managed-token threshold invoice pauses MANAGED runs until payment recovers;
  // BYO runs (the customer's own key) resolve to byo and pass straight through.
  if (await managedRunBlockedForPayment(orgId)) {
    return {
      error:
        "Managed runs are paused: a managed-token payment failed. Update your card under Settings → Billing — runs resume automatically once it's paid — or add your own provider key under Settings → Team.",
    };
  }

  // supabaseAdmin bypasses RLS, so verify rubric belongs to the user's team explicitly.
  const { data: rubric, error: rubricError } = await supabaseAdmin
    .from("rubrics")
    .select("id, criteria")
    .eq("id", rubricId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (rubricError) return { error: "Couldn't verify rubric. Please try again." };
  if (!rubric) return { error: "Rubric not found" };

  const criteriaCount = Array.isArray(rubric.criteria) ? rubric.criteria.length : 0;
  const pointCost = evalRunPointCost(rows.length, criteriaCount);

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const validEmails = (opts.notificationEmails ?? [])
    .slice(0, 50)
    .filter((e) => EMAIL_RE.test(e))
    .slice(0, 10);

  const { data: run, error: runError } = await supabaseAdmin
    .from("eval_runs")
    .insert({
      created_by: userId,
      rubric_id: rubricId,
      description: opts.description ?? null,
      notification_emails: validEmails,
    })
    .select("id")
    .single();

  if (runError || !run) {
    await log.error("eval_runs insert failed", { event: "eval_run.create_failed", rubric_id: rubricId, org_id: orgId, error: runError });
    return { error: "Failed to create eval run" };
  }

  // Reserve the run's exact point cost atomically (#180, ADR-0009). The run row
  // must exist first (the reservation references it), so a refusal rolls the
  // insert back. Reservation failure is a hard stop: no overage in this slice.
  let reservation: Awaited<ReturnType<typeof reserveEvalRunPoints>>;
  try {
    reservation = await reserveEvalRunPoints(orgId, run.id, pointCost, {
      row_count: rows.length,
      criteria_count: criteriaCount,
      per_row_cost: evalRunPointsPerRow(criteriaCount),
    });
  } catch (err) {
    await log.error("point reservation errored", { event: "eval_run.reserve_failed", run_id: run.id, org_id: orgId, error: err });
    // The error may have struck AFTER Postgres committed the reservation (lost
    // response) — roll back settle-first. No-op if nothing committed.
    await rollBackRun(run.id, orgId);
    // Fail closed: an unreadable ledger never grants a free run.
    return { error: "Couldn't check your team's Eval Point balance. Please try again." };
  }

  if (!reservation.reserved) {
    await supabaseAdmin.from("eval_runs").delete().eq("id", run.id);
    const remaining = Math.max(0, reservation.balance);

    await track(
      {
        name: "billing.points_limit_hit",
        props: { team_id: orgId, needed: pointCost, remaining, cap_usd: reservation.capUsd },
      },
      { userId }
    );

    // Payment-failing (#215): overage was suppressed because the card is failing,
    // so this refusal is "update your card", NOT "you hit your cap" — and it must
    // win over the cap branch below (the SQL may still echo the configured cap).
    // The payment failure is already surfaced (managed-fail email #186 / Stripe
    // dunning), so no extra notification here.
    if (reservation.paymentFailing) {
      return {
        error: `Eval Point overage is paused because your team's payment method is failing — update your card in Billing to run beyond your included Eval Points. This run needs ${pointCost.toLocaleString("en-US")}; ${remaining.toLocaleString("en-US")} remain this period.`,
        insufficientPoints: { needed: pointCost, remaining },
      };
    }

    // The limit email goes to the Team's Contributors — they own the plan.
    // At most once per billing period: a blocked user will retry the dialog,
    // and every retry lands here. billing_notifications' PK is the throttle.
    // With an Overage Cap set (#183) the wall is the cap, not the allotment —
    // the message and the email say so. ("Would take past", not "is fully
    // committed": a single large run can overshoot an untouched cap.)
    if (reservation.capUsd != null) {
      await notifyCapReached(orgId, reservation.capUsd, reservation.periodStart);
      return {
        error: `Not enough Eval Points: this run needs ${pointCost.toLocaleString("en-US")} and would take your team past its $${reservation.capUsd} monthly overage cap.`,
        insufficientPoints: { needed: pointCost, remaining },
      };
    }
    await notifyLimitOnce({
      orgId,
      kind: "points_limit",
      periodStart: reservation.periodStart,
      subject: (teamName) => `${teamName} has hit its Eval Point limit`,
      html: (teamName, billingUrl) =>
        pointsLimitEmailHtml({
          teamName,
          neededPoints: pointCost,
          remainingPoints: remaining,
          billingUrl,
        }),
    });

    return {
      error: `Not enough Eval Points: this run needs ${pointCost.toLocaleString("en-US")}, but only ${remaining.toLocaleString("en-US")} remain this period.`,
      insufficientPoints: { needed: pointCost, remaining },
    };
  }

  // The run is funded. If it dug into cap-backed overage, the warning email
  // may be due (once per period, at 80% of the cap). A reserve that left the
  // balance non-negative changed nothing about committed overage — any
  // crossing already happened on an earlier negative dig and was checked then.
  if (reservation.capUsd != null && reservation.balance < 0) {
    await maybeWarnNearCap(orgId, {
      capUsd: reservation.capUsd,
      plan: reservation.plan,
      periodStart: reservation.periodStart,
    });
  }

  // Managed Spend Cap pre-run gate (#185, ADR-0008 Meter 2). A paid Team with no
  // BYO key for the judge model's provider runs on the managed platform key —
  // metered in dollars and bounded by the Managed Spend Cap. Reserve this run's
  // estimated managed spend against the cap (atomic, race-safe); refuse if it
  // would push the Team past the cap. BYO runs (the customer's own tokens) and
  // Free Teams (blocked earlier, or BYO) never reach this. The worker re-checks
  // accrued actuals mid-run — this is the pre-run estimate gate.
  const keyMode = await resolveKeyModeForEstimate(orgId, ESTIMATE_JUDGE_PROVIDER);
  if (keyMode === KEY_MODE.managed) {
    const estimate = estimateManagedSpendUsd(
      reservation.plan,
      ESTIMATE_JUDGE_PROVIDER,
      ESTIMATE_JUDGE_MODEL,
      rows.length,
      criteriaCount
    );
    let capResult: Awaited<ReturnType<typeof getEffectiveManagedCap>>;
    try {
      capResult = await getEffectiveManagedCap(orgId);
    } catch (err) {
      await log.error("managed cap check errored", { event: "eval_run.managed_cap_check_failed", run_id: run.id, org_id: orgId, error: err });
      await rollBackRun(run.id, orgId);
      return { error: "Couldn't check your team's managed spend cap. Please try again." };
    }
    const { capUsd } = capResult;
    const markupPct = PLANS[reservation.plan].managedMarkupPct;
    if (estimate != null && capUsd != null && markupPct != null) {
      const { reserved } = await reserveManagedSpend(
        orgId,
        { evalRunId: run.id },
        estimate,
        capUsd,
        markupPct,
        { start: reservation.periodStart, end: reservation.periodEnd }
      );
      if (!reserved) {
        await rollBackRun(run.id, orgId);
        await track(
          {
            name: "billing.managed_spend_limit_hit",
            props: { team_id: orgId, estimate_usd: estimate, cap_usd: capUsd },
          },
          { userId }
        );
        await notifyManagedCapReached(orgId, capUsd, reservation.periodStart);
        return {
          error: `This run's estimated managed token spend (~${fmtRate(estimate)}) would take your team past its ${fmtUsd(capUsd)} monthly managed spend cap. Raise the cap on the Billing page, or add your own provider key under Settings → Team.`,
        };
      }
    }
  }

  const { error: rowsError } = await supabaseAdmin.from("eval_run_rows").insert(
    rows.map((row, i) => ({
      eval_run_id: run.id,
      row_index: i,
      user_input: row.userInput,
      agent_output: row.agentOutput,
      expected_output: row.expectedOutput ?? null,
      retrieval_context: row.retrievalContext ?? null,
    }))
  );

  if (rowsError) {
    await log.error("eval_run_rows insert failed", { event: "eval_run.rows_insert_failed", run_id: run.id, error: rowsError });
    await rollBackRun(run.id, orgId);
    return { error: "Failed to save input rows" };
  }

  const { error: enqueueError } = await supabaseAdmin.rpc(
    "enqueue_eval_run",
    { run_id: run.id }
  );

  if (enqueueError) {
    await log.error("enqueue_eval_run failed", { event: "eval_run.enqueue_failed", run_id: run.id, error: enqueueError });
    // A run that never reaches the queue never executes — there is no retry
    // mechanism, and leaving it 'queued' would pin its reservation for the
    // whole period. Roll the whole creation back instead.
    await rollBackRun(run.id, orgId);
    return { error: "Couldn't queue the eval run. Please try again." };
  } else {
    await log.info("eval run enqueued", {
      event: "eval_run.enqueued",
      run_id: run.id,
      rubric_id: rubricId,
      row_count: rows.length,
    });
    // Nudge the always-on worker to pick up this run without waiting out its poll interval.
    // Fire-and-forget — the worker runs continuously (it no longer scales to zero), so a failed
    // wake just costs up to one poll interval (~5s) of latency, not a stalled run.
    const workerWakeUrl = process.env.WORKER_WAKE_URL;
    const workerWakeSecret = process.env.WORKER_WAKE_SECRET;
    if (workerWakeUrl) {
      fetch(workerWakeUrl, {
        method: "POST",
        ...(workerWakeSecret ? { headers: { Authorization: `Bearer ${workerWakeSecret}` } } : {}),
      }).catch((err) => log.error("Worker wake failed", { event: "eval_run.worker_wake_failed", run_id: run.id, error: err }));
    }
  }


  await track(
    {
      name: "eval_run.created",
      props: {
        rubric_id: rubricId,
        row_count: rows.length,
        input_source: opts.inputSource,
      },
    },
    { userId }
  );

  return { runId: run.id };
}

// ---------- Read ----------

export async function getEvalRuns(rubricId: string): Promise<EvalRun[]> {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return [];

  // Verify rubric belongs to the team before listing its runs.
  const { data: rubric, error: rubricError } = await supabaseAdmin
    .from("rubrics")
    .select("id")
    .eq("id", rubricId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (rubricError) throw rubricError;
  if (!rubric) return [];

  const { data, error } = await supabaseAdmin
    .from("eval_runs")
    .select(
      "id, rubric_id, status, eval_type, description, notification_emails, overall_score, error_message, created_at"
    )
    .eq("rubric_id", rubricId)
    .is("deleted_at", null) // hide runs aged out of the plan's retention window (#187)
    .order("created_at", { ascending: false })
    .limit(RUBRIC_RUNS_DISPLAY_LIMIT);

  if (error) throw error;

  return (data ?? []).map((r) => ({
    id: r.id,
    rubricId: r.rubric_id,
    status: r.status,
    evalType: r.eval_type,
    description: r.description,
    notificationEmails: r.notification_emails ?? [],
    overallScore: r.overall_score != null ? Number(r.overall_score) : null,
    errorMessage: r.error_message,
    createdAt: r.created_at,
  }));
}

export async function getRunCriteriaBreakdown(
  runId: string
): Promise<{ name: string; score: number }[]> {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return [];

  const { data: run, error: runError } = await supabaseAdmin
    .from("eval_runs")
    .select("id, rubrics!inner(org_id)")
    .eq("id", runId)
    .eq("rubrics.org_id", orgId)
    .is("deleted_at", null) // a soft-deleted run is gone from every surface (#187)
    .maybeSingle();

  if (runError) throw runError;
  if (!run) return [];

  const { data: results, error: resultsErr } = await supabaseAdmin
    .from("eval_run_results")
    .select("criterion_name, score")
    .eq("eval_run_id", runId);

  if (resultsErr) throw resultsErr;

  const agg = new Map<string, { sum: number; n: number }>();
  for (const r of results ?? []) {
    const cur = agg.get(r.criterion_name) ?? { sum: 0, n: 0 };
    cur.sum += Number(r.score);
    cur.n += 1;
    agg.set(r.criterion_name, cur);
  }

  return [...agg.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { sum, n }]) => ({ name, score: sum / n }));
}

export async function getEvalRunDetails(
  runId: string
): Promise<EvalRunDetails | null> {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return null;

  // Join through rubrics to verify team ownership.
  const { data: run, error: runError } = await supabaseAdmin
    .from("eval_runs")
    .select(
      "id, rubric_id, status, eval_type, description, notification_emails, overall_score, error_message, created_at, rubrics!inner(org_id)"
    )
    .eq("id", runId)
    .eq("rubrics.org_id", orgId)
    .is("deleted_at", null) // a soft-deleted run's detail page 404s like any unknown id (#187)
    .maybeSingle();

  if (runError) throw runError;
  if (!run) return null;

  const { data: results, error: resultsErr } = await supabaseAdmin
    .from("eval_run_results")
    .select("row_index, criterion_name, score, reasoning")
    .eq("eval_run_id", runId)
    .order("row_index", { ascending: true })
    .order("criterion_name", { ascending: true });

  if (resultsErr) throw resultsErr;

  return {
    id: run.id,
    rubricId: run.rubric_id,
    status: run.status,
    evalType: run.eval_type,
    description: run.description,
    notificationEmails: run.notification_emails ?? [],
    overallScore: run.overall_score != null ? Number(run.overall_score) : null,
    errorMessage: run.error_message,
    createdAt: run.created_at,
    results: (results ?? []).map((r) => ({
      rowIndex: r.row_index,
      criterionName: r.criterion_name,
      score: Number(r.score),
      reasoning: r.reasoning,
    })),
  };
}

export async function getEvalRunComparison(
  runIdA: string,
  runIdB: string
): Promise<EvalRunComparison | null> {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return null;

  const fetchRun = async (runId: string) => {
    const { data, error } = await supabaseAdmin
      .from("eval_runs")
      .select(
        "id, rubric_id, status, eval_type, description, notification_emails, overall_score, error_message, created_at, rubrics!inner(org_id)"
      )
      .eq("id", runId)
      .eq("rubrics.org_id", orgId)
      .is("deleted_at", null) // soft-deleted runs can't be compared either (#187)
      .maybeSingle();
    if (error) throw error;
    return data;
  };

  const [runA, runB] = await Promise.all([
    fetchRun(runIdA),
    fetchRun(runIdB),
  ]);
  if (!runA || !runB) return null;

  if (runA.rubric_id !== runB.rubric_id) return null;

  const fetchRows = async (runId: string) => {
    const { data, error } = await supabaseAdmin
      .from("eval_run_rows")
      .select("row_index, user_input, agent_output, expected_output")
      .eq("eval_run_id", runId)
      .order("row_index", { ascending: true });
    if (error) throw error;
    return data ?? [];
  };

  const fetchResults = async (runId: string) => {
    const { data, error } = await supabaseAdmin
      .from("eval_run_results")
      .select("row_index, criterion_name, score, reasoning")
      .eq("eval_run_id", runId)
      .order("row_index", { ascending: true })
      .order("criterion_name", { ascending: true });
    if (error) throw error;
    return data ?? [];
  };

  const [rowsA, rowsB, resultsA, resultsB] = await Promise.all([
    fetchRows(runIdA),
    fetchRows(runIdB),
    fetchResults(runIdA),
    fetchResults(runIdB),
  ]);

  function mapSide(
    run: NonNullable<Awaited<ReturnType<typeof fetchRun>>>,
    rows: Awaited<ReturnType<typeof fetchRows>>,
    results: Awaited<ReturnType<typeof fetchResults>>
  ): RunComparisonSide {
    return {
      id: run.id,
      rubricId: run.rubric_id,
      status: run.status,
      evalType: run.eval_type,
      description: run.description,
      notificationEmails: run.notification_emails ?? [],
      overallScore: run.overall_score != null ? Number(run.overall_score) : null,
      errorMessage: run.error_message,
      createdAt: run.created_at,
      results: results.map((r) => ({
        rowIndex: r.row_index,
        criterionName: r.criterion_name,
        score: Number(r.score),
        reasoning: r.reasoning,
      })),
      rows: rows.map((r) => ({
        rowIndex: r.row_index,
        userInput: r.user_input,
        agentOutput: r.agent_output,
        expectedOutput: r.expected_output ?? null,
      })),
    };
  }

  return {
    runA: mapSide(runA, rowsA, resultsA),
    runB: mapSide(runB, rowsB, resultsB),
  };
}
