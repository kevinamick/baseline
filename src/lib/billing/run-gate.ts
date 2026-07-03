import "server-only";
import { log } from "@/lib/logging/server";
import { track } from "@/lib/analytics/server";
import { getSeatCapState, seatCapError } from "@/lib/billing/seats";
import {
  evalRunBlockedForMissingKey,
  managedRunBlockedForPayment,
  resolveKeyModeForEstimate,
  resolveJudgeKeyModeForEstimate,
  KEY_MODE,
  type KeyMode,
} from "@/lib/llm/key-gate";
import { reserveEvalRunPoints } from "@/lib/billing/ledger";
import { notifyPointsLimitOnce, notifyLimitOnce } from "@/lib/billing/limit-notifications";
import { maybeWarnNearCap, notifyCapReached } from "@/lib/billing/overage";
import {
  reserveOptimizationRun,
  reserveOptimizationPoints,
} from "@/lib/billing/allowance";
import { optimizationLimitEmailHtml } from "@/lib/email/templates/optimization-limit";
import { estimateManagedSpendUsd } from "@/lib/billing/managed-spend-estimate";
import {
  getEffectiveManagedCap,
  reserveManagedSpend,
  notifyManagedCapReached,
} from "@/lib/billing/managed-spend";
import { PLANS, type PlanSlug } from "@/lib/billing/plans";
import { fmtRate, fmtUsd } from "@/lib/billing/format";
import type { LlmProvider } from "@/lib/llm/providers";

/**
 * The Run Gate (#377): one module owning every run start's reserve-or-refuse
 * billing pipeline — seat cap → missing-key / managed-payment gate → Eval
 * Point or run-allowance reserve → Managed Spend Cap reserve → limit
 * notification → rollback on any failure. Before this module the pipeline was
 * hand-inlined at three call sites (interactive eval runs, optimization runs,
 * the scheduled claim gate) with diverging judge key-mode resolvers, diverging
 * payment-beats-cap branches, and two separate rollback helpers. This slice
 * extracts the seam and ports ONE caller, `createEvalRun`
 * (src/app/actions/eval-runs.ts) — the Optimization Run start (#382) and the
 * scheduled claim gate (#383) port in follow-up PRs.
 *
 * Two entry points, not one, by a deliberate constraint: the point/managed-spend
 * RESERVE steps write ledger rows that FK-reference the run's own id (see
 * `settle_eval_run_points`'s comment in eval-runs.ts on delete-order), so the
 * run row must already exist before they can run — but the run row's own
 * columns (e.g. `criteria_count`-derived cost) aren't knowable until AFTER the
 * cheap seat/key/payment checks have already passed today, and reordering them
 * around row creation would change refusal precedence for a Team that fails
 * both a cheap gate and an expensive one (a behavior change the ADR-preserving
 * refactor forbids). So `checkRunPreflight` runs first (no row, no reservation)
 * and `reserveRunOrRefuse` runs second, once the caller's row exists — together
 * they ARE the one seam; a caller always calls both, in that order:
 *
 *   const preflight = await checkRunPreflight({ ... });
 *   if (!preflight.ok) return { error: preflight.refusal.error };
 *   // ... action creates the run row, computes its point cost ...
 *   const reserved = await reserveRunOrRefuse({ ... });
 *   if (!reserved.ok) return { error: reserved.refusal.error };
 *
 * The request shapes are deliberately data-driven (a `PointReserveSpec`
 * discriminated union, a list of `ManagedSpendTerm`s, and a `KeyModeStrategy`
 * per term) so the other two callers can adopt them by WIDENING these unions —
 * adding an "optimization_unit" / "optimization_points" reserve kind, and a
 * second/third managed-spend term for the reflect + Managed Agent target legs
 * — rather than reshaping the entry points or copying their bodies again.
 */

// ---------- Single-source enums ----------

/** Run kinds the gate has been ported to. Widen when #382/#383 land. */
export const RUN_KIND = {
  eval: "eval",
  // #382: an Optimization Run start.
  optimization: "optimization",
} as const;
export type RunKind = (typeof RUN_KIND)[keyof typeof RUN_KIND];

/** Every refusal the gate can return, so a caller can switch on `kind` instead of parsing `error`. */
export const RUN_REFUSAL = {
  seatCap: "seat_cap",
  missingKey: "missing_key",
  managedPaymentFailing: "managed_payment_failing",
  insufficientPoints: "insufficient_points",
  managedCapExceeded: "managed_cap_exceeded",
  // #382: an Optimization Run's included run-count allowance is exhausted (the
  // dual-meter "unit" branch, ADR-0016) — distinct from `insufficientPoints`,
  // which is the "points" branch past that allowance.
  optimizationAllowanceExhausted: "optimization_allowance_exhausted",
} as const;
export type RunRefusalKind = (typeof RUN_REFUSAL)[keyof typeof RUN_REFUSAL];

/**
 * How a managed-spend term's byo/managed key mode is resolved (AGENTS.md's
 * "declared inputs to the gate, not divergent copies of its body"):
 *   - judgeAnyByo: the eval judge has no per-run model, so ANY runtime-ready BYO
 *     key wins (resolveJudgeKeyModeForEstimate) — mirrors the worker's resolveEvalJudge.
 *   - perProvider: a single named provider's key existence decides (resolveKeyModeForEstimate)
 *     — what a Managed Agent's fixed-provider target (and, later, the reflect leg) needs.
 */
export const KEY_MODE_STRATEGY = {
  perProvider: "per_provider",
  judgeAnyByo: "judge_any_byo",
} as const;
export type KeyModeStrategy = (typeof KEY_MODE_STRATEGY)[keyof typeof KEY_MODE_STRATEGY];

// ---------- Shared result shapes ----------

export interface RunGateRefusal {
  kind: RunRefusalKind;
  error: string;
  insufficientPoints?: { needed: number; remaining: number };
}

export type RunGateCheckResult = { ok: true } | { ok: false; refusal: RunGateRefusal };

export interface RunGateReserved {
  ok: true;
  plan: PlanSlug;
  periodStart: string;
  periodEnd: string;
}

export type RunGateResult = RunGateReserved | { ok: false; refusal: RunGateRefusal };

// ---------- Shared refusal copy ----------
// Owned once here so a future caller (#382) can't drift the wording — both
// eval-run and optimization-run refusals use this exact copy today.

const MISSING_KEY_MESSAGE =
  "Add an LLM provider key to run: the Free plan uses your own provider key. Add one under Settings → Team.";

const MANAGED_PAYMENT_BLOCKED_MESSAGE =
  "Managed runs are paused: a managed-token payment failed. Update your card under Settings → Billing — runs resume automatically once it's paid — or add your own provider key under Settings → Team.";

// ---------- Phase 1: preflight (seat cap, missing key, managed payment) ----------

export interface RunPreflightRequest {
  runKind: RunKind;
  orgId: string;
  /** Verb for the seat-cap message, e.g. "run evals" / "start optimization runs". */
  actionLabel: string;
  /** Eval runs: Free has no managed fallback, so a missing BYO key fails closed (#184). */
  requireProviderKeyForFreePlan: boolean;
  /** Providers whose managed mode must not be payment-blocked before anything is reserved. */
  managedPaymentCheckProviders: readonly LlmProvider[];
}

/**
 * The cheap, row-less half of the gate: seat cap, then (optionally) the BYO-key
 * gate, then the managed-payment fail-closed gate for every declared provider —
 * in that order, matching every caller's refusal precedence today.
 */
export async function checkRunPreflight(req: RunPreflightRequest): Promise<RunGateCheckResult> {
  // Seat-cap gate (#182): a Team over its plan's seats is fail-closed until it fits.
  const seats = await getSeatCapState(req.orgId);
  if (seats.violated) {
    return {
      ok: false,
      refusal: { kind: RUN_REFUSAL.seatCap, error: seatCapError(seats, req.actionLabel) },
    };
  }

  // BYO-key gate (#184): only eval runs require it today (a Free Team is gated
  // by allowance before ever reaching this for an optimization run).
  if (req.requireProviderKeyForFreePlan && (await evalRunBlockedForMissingKey(req.orgId))) {
    return { ok: false, refusal: { kind: RUN_REFUSAL.missingKey, error: MISSING_KEY_MESSAGE } };
  }

  // Managed-payment fail-closed gate (#186, ADR-0008 Meter 2): checked per
  // declared provider (a run can be multi-provider — judge vs target).
  for (const provider of req.managedPaymentCheckProviders) {
    if (await managedRunBlockedForPayment(req.orgId, provider)) {
      return {
        ok: false,
        refusal: { kind: RUN_REFUSAL.managedPaymentFailing, error: MANAGED_PAYMENT_BLOCKED_MESSAGE },
      };
    }
  }

  return { ok: true };
}

// ---------- Phase 2: reserve (Eval Point / allowance, then Managed Spend Cap) ----------

/** One managed-spend candidate term (e.g. the judge, or later the reflect/target legs). */
export interface ManagedSpendTerm {
  keyModeStrategy: KeyModeStrategy;
  provider: LlmProvider;
  model: string;
  /** rows/instances the estimate multiplies by criteriaCount into a call count. */
  volume: number;
  criteriaCount: number;
}

export interface EvalPointsReserveSpec {
  kind: "eval_points";
  pointCost: number;
  metadata: { row_count: number; criteria_count: number; per_row_cost: number };
}

/**
 * #382: an Optimization Run WITHIN its plan's included run-count (ADR-0016) —
 * one allowance unit, zero points. `period` is the caller's own pre-resolved
 * allowance snapshot (`getOptimizationAllowance`), passed through so the
 * refusal message/notification and the reservation itself agree on the same
 * period — mirroring why `reserveOptimizationRun` accepts it instead of
 * re-resolving.
 */
export interface OptimizationUnitReserveSpec {
  kind: "optimization_unit";
  period: { periodStart: string; periodEnd: string; included: number; plan: PlanSlug };
}

/**
 * #382: an Optimization Run PAST its included run-count (ADR-0016) — worst-case
 * Eval Points, metered and refused exactly like `eval_points` but with
 * optimization-specific copy/notification (a paid Team's run-count allowance
 * benefit, not a raw Eval Point purchase).
 */
export interface OptimizationPointsReserveSpec {
  kind: "optimization_points";
  pointCost: number;
  /** The plan's included run-count, for the refusal copy and the limit email. */
  included: number;
  metadata: { criteria_count: number; budget_rollouts: number; per_rollout_cost: number };
}

/**
 * Widened for #382's dual-meter (allowance unit vs worst-case Eval Points)
 * branch — additive, not a reshape of this type or its callers.
 */
export type PointReserveSpec =
  | EvalPointsReserveSpec
  | OptimizationUnitReserveSpec
  | OptimizationPointsReserveSpec;

export interface RunGateCallbacks {
  /** Nothing was reserved yet — delete the half-created run row outright. */
  deleteRun: () => Promise<void>;
  /**
   * Undo whatever reservations succeeded before the failing step (settle
   * points + release managed spend), then delete the run row. Must be safe to
   * call even when a given meter was never reserved (a 'skipped' settle is a
   * no-op release).
   */
  rollbackReservations: () => Promise<void>;
}

export interface RunGateReserveRequest {
  runKind: RunKind;
  orgId: string;
  userId: string;
  /** The run row's id — must already exist; reservations FK-reference it. */
  runId: string;
  pointReserve: PointReserveSpec;
  managedSpendTerms: readonly ManagedSpendTerm[];
  managedSpendRef: { evalRunId: string } | { optRunId: string };
  callbacks: RunGateCallbacks;
}

/**
 * The row-owning half of the gate, called once the caller's run row exists:
 * reserve the run's Eval Point / allowance cost, then (if the run resolves to
 * the managed key) its estimated Managed Spend Cap term(s) — reserving
 * everything or returning the first typed refusal, with rollback of any
 * partial reservation already applied.
 */
export async function reserveRunOrRefuse(req: RunGateReserveRequest): Promise<RunGateResult> {
  const pointResult = await reservePointsOrRefuse(req);
  if (!pointResult.ok) return pointResult;
  const { plan, periodStart, periodEnd } = pointResult;

  return reserveManagedSpendOrRefuse(req, plan, periodStart, periodEnd);
}

async function reservePointsOrRefuse(req: RunGateReserveRequest): Promise<RunGateResult> {
  const spec = req.pointReserve;
  switch (spec.kind) {
    case "eval_points":
      return reserveEvalPointsOrRefuse(req, spec);
    case "optimization_unit":
      return reserveOptimizationUnitOrRefuse(req, spec);
    case "optimization_points":
      return reserveOptimizationPointsOrRefuse(req, spec);
    default: {
      // Assigning `spec` (not `spec.kind`) is required for the exhaustiveness
      // check to narrow to `never` once the union has 2+ members — TS doesn't
      // narrow a property-access expression the same way for this pattern.
      const exhaustive: never = spec;
      throw new Error(`Run Gate: unhandled point reserve kind: ${String((exhaustive as { kind: unknown }).kind)}`);
    }
  }
}

async function reserveEvalPointsOrRefuse(
  req: RunGateReserveRequest,
  spec: EvalPointsReserveSpec
): Promise<RunGateResult> {
  let reservation: Awaited<ReturnType<typeof reserveEvalRunPoints>>;
  try {
    reservation = await reserveEvalRunPoints(req.orgId, req.runId, spec.pointCost, spec.metadata);
  } catch (err) {
    await log.error("point reservation errored", {
      event: "run_gate.reserve_failed",
      run_id: req.runId,
      org_id: req.orgId,
      run_kind: req.runKind,
      error: err,
    });
    // The error may have struck AFTER Postgres committed the reservation (lost
    // response) — roll back settle-first. No-op if nothing committed.
    await req.callbacks.rollbackReservations();
    return {
      ok: false,
      refusal: {
        kind: RUN_REFUSAL.insufficientPoints,
        error: "Couldn't check your team's Eval Point balance. Please try again.",
      },
    };
  }

  if (!reservation.reserved) {
    // Nothing was reserved — delete outright, no settle needed.
    await req.callbacks.deleteRun();
    const remaining = Math.max(0, reservation.balance);

    await track(
      {
        name: "billing.points_limit_hit",
        props: { team_id: req.orgId, needed: spec.pointCost, remaining, cap_usd: reservation.capUsd },
      },
      { userId: req.userId }
    );

    // Payment-failing (#215) wins over the cap message: overage was suppressed
    // because the card is failing, so this refusal is "update your card", NOT
    // "you hit your cap" — the payment failure is already surfaced elsewhere
    // (managed-fail email #186 / Stripe dunning), so no extra notification here.
    if (reservation.paymentFailing) {
      return {
        ok: false,
        refusal: {
          kind: RUN_REFUSAL.insufficientPoints,
          error: `Eval Point overage is paused because your team's payment method is failing — update your card in Billing to run beyond your included Eval Points. This run needs ${spec.pointCost.toLocaleString("en-US")}; ${remaining.toLocaleString("en-US")} remain this period.`,
          insufficientPoints: { needed: spec.pointCost, remaining },
        },
      };
    }

    // With an Overage Cap set (#183) the wall is the cap, not the allotment —
    // the message and the email say so.
    if (reservation.capUsd != null) {
      await notifyCapReached(req.orgId, reservation.capUsd, reservation.periodStart);
      return {
        ok: false,
        refusal: {
          kind: RUN_REFUSAL.insufficientPoints,
          error: `Not enough Eval Points: this run needs ${spec.pointCost.toLocaleString("en-US")} and would take your team past its $${reservation.capUsd} monthly overage cap.`,
          insufficientPoints: { needed: spec.pointCost, remaining },
        },
      };
    }

    // At most once per billing period: a blocked user will retry, and every retry lands here.
    await notifyPointsLimitOnce({
      orgId: req.orgId,
      periodStart: reservation.periodStart,
      neededPoints: spec.pointCost,
      remainingPoints: remaining,
    });

    return {
      ok: false,
      refusal: {
        kind: RUN_REFUSAL.insufficientPoints,
        error: `Not enough Eval Points: this run needs ${spec.pointCost.toLocaleString("en-US")}, but only ${remaining.toLocaleString("en-US")} remain this period.`,
        insufficientPoints: { needed: spec.pointCost, remaining },
      },
    };
  }

  // Funded. If it dug into cap-backed overage, the warning email may be due
  // (once per period, at 80% of the cap). A reserve that left the balance
  // non-negative changed nothing about committed overage.
  if (reservation.capUsd != null && reservation.balance < 0) {
    await maybeWarnNearCap(req.orgId, {
      capUsd: reservation.capUsd,
      plan: reservation.plan,
      periodStart: reservation.periodStart,
    });
  }

  return {
    ok: true,
    plan: reservation.plan,
    periodStart: reservation.periodStart,
    periodEnd: reservation.periodEnd,
  };
}

async function resolveTermKeyMode(orgId: string, term: ManagedSpendTerm): Promise<KeyMode> {
  return term.keyModeStrategy === KEY_MODE_STRATEGY.judgeAnyByo
    ? resolveJudgeKeyModeForEstimate(orgId)
    : resolveKeyModeForEstimate(orgId, term.provider);
}

async function reserveManagedSpendOrRefuse(
  req: RunGateReserveRequest,
  plan: PlanSlug,
  periodStart: string,
  periodEnd: string
): Promise<RunGateResult> {
  // Sum only the terms whose OWN provider resolves to the managed key — a BYO
  // term never reserves managed dollars it won't be metered for (#358).
  let estimate = 0;
  for (const term of req.managedSpendTerms) {
    const mode = await resolveTermKeyMode(req.orgId, term);
    if (mode !== KEY_MODE.managed) continue;
    estimate += estimateManagedSpendUsd(plan, term.provider, term.model, term.volume, term.criteriaCount) ?? 0;
  }

  // No managed term applies (fully BYO/Free), or every term returned an
  // unpriced/zero-call estimate — nothing to reserve.
  if (estimate <= 0) {
    return { ok: true, plan, periodStart, periodEnd };
  }

  let capResult: Awaited<ReturnType<typeof getEffectiveManagedCap>>;
  try {
    capResult = await getEffectiveManagedCap(req.orgId);
  } catch (err) {
    await log.error("managed cap check errored", {
      event: "run_gate.managed_cap_check_failed",
      run_id: req.runId,
      org_id: req.orgId,
      run_kind: req.runKind,
      error: err,
    });
    await req.callbacks.rollbackReservations();
    return {
      ok: false,
      refusal: {
        kind: RUN_REFUSAL.managedCapExceeded,
        error: "Couldn't check your team's managed spend cap. Please try again.",
      },
    };
  }

  const { capUsd } = capResult;
  const markupPct = PLANS[plan].managedMarkupPct;
  if (capUsd == null || markupPct == null) {
    return { ok: true, plan, periodStart, periodEnd };
  }

  const { reserved } = await reserveManagedSpend(
    req.orgId,
    req.managedSpendRef,
    estimate,
    capUsd,
    markupPct,
    { start: periodStart, end: periodEnd }
  );
  if (!reserved) {
    await req.callbacks.rollbackReservations();
    await track(
      {
        name: "billing.managed_spend_limit_hit",
        props: { team_id: req.orgId, estimate_usd: estimate, cap_usd: capUsd },
      },
      { userId: req.userId }
    );
    await notifyManagedCapReached(req.orgId, capUsd, periodStart);
    return {
      ok: false,
      refusal: {
        kind: RUN_REFUSAL.managedCapExceeded,
        error: `This run's estimated managed token spend (~${fmtRate(estimate)}) would take your team past its ${fmtUsd(capUsd)} monthly managed spend cap. Raise the cap on the Billing page, or add your own provider key under Settings → Team.`,
      },
    };
  }

  return { ok: true, plan, periodStart, periodEnd };
}

// ---------- #382: Optimization Run dual-meter reserve kinds (ADR-0016) ----------

/**
 * WITHIN the plan's included run-count: reserve one allowance unit (zero
 * points). Mirrors `reserveEvalPointsOrRefuse`'s shape, but the refusal here is
 * a plain hard-stop (no cap/payment-failing distinction — the included count
 * is the whole benefit at this meter) always followed by the once-per-period
 * limit email.
 */
async function reserveOptimizationUnitOrRefuse(
  req: RunGateReserveRequest,
  spec: OptimizationUnitReserveSpec
): Promise<RunGateResult> {
  let unit: Awaited<ReturnType<typeof reserveOptimizationRun>>;
  try {
    unit = await reserveOptimizationRun(req.orgId, req.runId, spec.period);
  } catch (err) {
    await log.error("optimization allowance reservation errored", {
      event: "run_gate.reserve_failed",
      run_id: req.runId,
      org_id: req.orgId,
      run_kind: req.runKind,
      error: err,
    });
    // Same reasoning as the Eval Point reserve: the error may have struck AFTER
    // the RPC committed (lost response) — roll back settle-first, a no-op if
    // nothing committed.
    await req.callbacks.rollbackReservations();
    return {
      ok: false,
      refusal: {
        kind: RUN_REFUSAL.insufficientPoints,
        error: "Couldn't check your team's run allowance. Please try again.",
      },
    };
  }

  if (!unit.reserved) {
    // A concurrent run took the last included unit between the caller's
    // pre-check and here — nothing was reserved, delete outright.
    await req.callbacks.deleteRun();
    await notifyLimitOnce({
      orgId: req.orgId,
      kind: "optimization_runs_limit",
      periodStart: unit.periodStart,
      subject: (teamName) => `${teamName} has used its Optimization Runs for this period`,
      html: (teamName, billingUrl) =>
        optimizationLimitEmailHtml({ teamName, included: spec.period.included, billingUrl }),
    });
    return {
      ok: false,
      refusal: {
        kind: RUN_REFUSAL.optimizationAllowanceExhausted,
        error: `Your team has used all ${spec.period.included} Optimization Runs included this period.`,
      },
    };
  }

  // reserveOptimizationRun doesn't echo periodEnd (it never needs it), so carry
  // it from the caller's own pre-resolved allowance snapshot.
  return { ok: true, plan: unit.plan, periodStart: unit.periodStart, periodEnd: spec.period.periodEnd };
}

/**
 * PAST the plan's included run-count: reserve worst-case Eval Points. Same
 * payment-failing / cap / plain-limit precedence as `reserveEvalPointsOrRefuse`,
 * with optimization-specific copy, track event, and (non-cap, non-payment-
 * failing) limit email.
 */
async function reserveOptimizationPointsOrRefuse(
  req: RunGateReserveRequest,
  spec: OptimizationPointsReserveSpec
): Promise<RunGateResult> {
  let points: Awaited<ReturnType<typeof reserveOptimizationPoints>>;
  try {
    points = await reserveOptimizationPoints(req.orgId, req.runId, spec.pointCost, spec.metadata);
  } catch (err) {
    await log.error("optimization point reservation errored", {
      event: "run_gate.reserve_failed",
      run_id: req.runId,
      org_id: req.orgId,
      run_kind: req.runKind,
      error: err,
    });
    await req.callbacks.rollbackReservations();
    return {
      ok: false,
      refusal: {
        kind: RUN_REFUSAL.insufficientPoints,
        error: "Couldn't check your team's Eval Point balance. Please try again.",
      },
    };
  }

  if (!points.reserved) {
    // Nothing was reserved — delete outright, no settle needed.
    await req.callbacks.deleteRun();

    await track(
      {
        name: "billing.optimization_limit_hit",
        props: { team_id: req.orgId, included: spec.included, cap_usd: points.capUsd },
      },
      { userId: req.userId }
    );

    // Payment-failing (#215) wins over the cap message, same precedence as the
    // Eval Point reserve.
    if (points.paymentFailing) {
      return {
        ok: false,
        refusal: {
          kind: RUN_REFUSAL.insufficientPoints,
          error: `Optimization Run overage is paused because your team's payment method is failing — update your card in Billing to start runs beyond the ${spec.included} included this period.`,
        },
      };
    }

    if (points.capUsd != null) {
      await notifyCapReached(req.orgId, points.capUsd, points.periodStart);
      return {
        ok: false,
        refusal: {
          kind: RUN_REFUSAL.insufficientPoints,
          error: `This optimization run needs ${spec.pointCost.toLocaleString()} Eval Points, but your team has used its included Optimization Runs and another would take it past its $${points.capUsd} monthly overage cap.`,
        },
      };
    }

    // At most once per billing period: a blocked user will retry, and every retry lands here.
    await notifyLimitOnce({
      orgId: req.orgId,
      kind: "optimization_runs_limit",
      periodStart: points.periodStart,
      subject: (teamName) => `${teamName} has used its Optimization Runs for this period`,
      html: (teamName, billingUrl) =>
        optimizationLimitEmailHtml({ teamName, included: spec.included, billingUrl }),
    });
    return {
      ok: false,
      refusal: {
        kind: RUN_REFUSAL.insufficientPoints,
        error: `Your team has used its ${spec.included} included Optimization Runs, and this run's ${spec.pointCost.toLocaleString()} Eval Points exceed your remaining balance. Add Eval Points or set an Overage Cap in Billing.`,
      },
    };
  }

  // Funded — possibly into cap-backed overage; the 80% warning may be due.
  if (points.capUsd != null && points.balance < 0) {
    await maybeWarnNearCap(req.orgId, {
      capUsd: points.capUsd,
      plan: points.plan,
      periodStart: points.periodStart,
    });
  }

  return { ok: true, plan: points.plan, periodStart: points.periodStart, periodEnd: points.periodEnd };
}
