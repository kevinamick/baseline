import "server-only";
import { createTranslator } from "next-intl";
import { getTranslations } from "next-intl/server";
import enMessages from "../../../messages/en.json";
import { log } from "@/lib/logging/server";
import { track } from "@/lib/analytics/server";
import { getSeatCapState } from "@/lib/billing/seats";
import {
  evalRunBlockedForMissingKey,
  managedRunBlockedForPayment,
  resolveKeyModeForEstimate,
  resolveJudgeKeyModeForEstimate,
  KEY_MODE,
  type KeyMode,
} from "@/lib/llm/key-gate";
import { reserveEvalRunPoints } from "@/lib/billing/ledger";
import { notifyPointsLimitOnce } from "@/lib/billing/limit-notifications";
import { maybeWarnNearCap, notifyCapReached } from "@/lib/billing/overage";
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
} as const;
export type RunKind = (typeof RUN_KIND)[keyof typeof RUN_KIND];

/** Every refusal the gate can return, so a caller can switch on `kind` instead of parsing `error`. */
export const RUN_REFUSAL = {
  seatCap: "seat_cap",
  missingKey: "missing_key",
  managedPaymentFailing: "managed_payment_failing",
  insufficientPoints: "insufficient_points",
  managedCapExceeded: "managed_cap_exceeded",
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
  /**
   * The refusal copy's catalog key (under `Billing.runGate`) and its ICU
   * params. `error` is the same message rendered in English — the gate is not
   * request-scoped (the scheduled claim path has no user locale), so callers
   * inside a request re-render via `localizeRunGateError` and everything else
   * falls back to `error`.
   */
  messageKey: RunGateMessageKey;
  messageParams?: RunGateMessageParams;
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
// Owned once — in the catalogs. Every refusal message lives under
// `Billing.runGate` in messages/{en,es,fr}.json (en authoritative), so a
// future caller can't drift the wording and every locale ships the same copy.
// The gate renders the English fallback itself because it also runs outside a
// request (the scheduled claim path); request-scoped callers re-render in the
// user's locale via `localizeRunGateError`.

export type RunGateMessageKey = keyof (typeof enMessages)["Billing"]["runGate"];
export type RunGateMessageParams = Record<string, string | number>;

const enRunGate = createTranslator({
  locale: "en",
  messages: enMessages,
  namespace: "Billing.runGate",
});

/** messageKey + params + the en-rendered fallback, spread into a refusal. */
function refusalCopy(messageKey: RunGateMessageKey, messageParams?: RunGateMessageParams) {
  return {
    messageKey,
    messageParams,
    error: enRunGate(messageKey, messageParams),
  };
}

/** Full-sentence seat-cap copy per run kind — no verb interpolation, so es/fr grammar stays natural. */
const SEAT_CAP_MESSAGE_KEY: Record<RunKind, RunGateMessageKey> = {
  [RUN_KIND.eval]: "seatCapEval",
};

/**
 * Render a refusal in the requester's locale. Outside a request scope (the
 * scheduled claim path, node tests) next-intl has no locale to resolve, so
 * this falls back to the gate's English-rendered `error`.
 */
export async function localizeRunGateError(refusal: RunGateRefusal): Promise<string> {
  try {
    const t = await getTranslations("Billing.runGate");
    return t(refusal.messageKey, refusal.messageParams);
  } catch {
    return refusal.error;
  }
}

// ---------- Phase 1: preflight (seat cap, missing key, managed payment) ----------

export interface RunPreflightRequest {
  runKind: RunKind;
  orgId: string;
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
      refusal: {
        kind: RUN_REFUSAL.seatCap,
        ...refusalCopy(SEAT_CAP_MESSAGE_KEY[req.runKind], {
          members: seats.memberCount,
          seatLimit: seats.seatLimit ?? 0,
        }),
      },
    };
  }

  // BYO-key gate (#184): only eval runs require it today (a Free Team is gated
  // by allowance before ever reaching this for an optimization run).
  if (req.requireProviderKeyForFreePlan && (await evalRunBlockedForMissingKey(req.orgId))) {
    return {
      ok: false,
      refusal: { kind: RUN_REFUSAL.missingKey, ...refusalCopy("missingKey") },
    };
  }

  // Managed-payment fail-closed gate (#186, ADR-0008 Meter 2): checked per
  // declared provider (a run can be multi-provider — judge vs target).
  for (const provider of req.managedPaymentCheckProviders) {
    if (await managedRunBlockedForPayment(req.orgId, provider)) {
      return {
        ok: false,
        refusal: {
          kind: RUN_REFUSAL.managedPaymentFailing,
          ...refusalCopy("managedPaymentFailing"),
        },
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
 * Widen with an "optimization_unit" / "optimization_points" member when #382
 * ports startOptimizationRun's dual-meter (allowance unit vs worst-case Eval
 * Points) branch — additive, not a reshape of this type or its callers.
 */
export type PointReserveSpec = EvalPointsReserveSpec;

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
    default: {
      const exhaustive: never = spec.kind;
      throw new Error(`Run Gate: unhandled point reserve kind: ${String(exhaustive)}`);
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
        ...refusalCopy("pointsCheckFailed"),
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
          ...refusalCopy("pointsPaymentPaused", { needed: spec.pointCost, remaining }),
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
          ...refusalCopy("pointsCapBlocked", { needed: spec.pointCost, capUsd: reservation.capUsd }),
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
        ...refusalCopy("pointsExhausted", { needed: spec.pointCost, remaining }),
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
        ...refusalCopy("managedCapCheckFailed"),
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
        ...refusalCopy("managedCapExceeded", { estimate: fmtRate(estimate), cap: fmtUsd(capUsd) }),
      },
    };
  }

  return { ok: true, plan, periodStart, periodEnd };
}
