// The managed-metering caller protocol, collapsed into one seam (#384). Every LLM call a run
// makes — judge, Reflection/generation, a Managed Agent's target — used to repeat the same
// six-step ritual at its call site: resolve the provider key -> throw terminal if none -> if
// Managed Key, fail closed on an unpriced model -> build the managed meter -> fail closed if the
// meter is missing its reservation (#358) -> record usage, and in the catch, attribute a BYO Key
// failure and convert a billing error to terminal. That ritual had already forked into twin
// helpers (two terminal converters, two BYO-attribution loggers) in evalrun/activities.ts and
// gepa/activities.ts, with the invariant documented only in prose. This module is the one
// interface a new call site can't forget a guard through.
//
// One eval-run vs optimization-run divergence is NOT a bug to fix here — it's preserved
// exactly (see worker/AGENTS.md and #384's PR description): the two workflows classify a
// terminal Activity failure by DIFFERENT `ApplicationFailure` `type` markers (eval folds every
// terminal reason into one "EvalRunTerminal" marker; GEPA's circuit breaker —
// gepa/circuit-breaker.ts — branches on distinct markers per failure class).
// `MeteredCallTerminals` carries whichever pair the caller's workflow reads.
//
// The missing-managed-spend-reservation guard (#358/#292/#410) is now uniform across every call
// site — the eval judge, the eval Managed-Agent target, GEPA's Managed-Agent target, and GEPA's
// own judge/reflect/generation calls all fail closed on a managed call with no reservation. There
// is no per-call-site opt-out.
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApplicationFailure } from "@temporalio/common";
import { createProvider, type ProviderOpts } from "./factory.js";
import type { RuntimeProvider, TokenUsage } from "./llm.js";
import {
  resolveProviderKey,
  MISSING_PROVIDER_KEY_MESSAGE,
  type ResolvedKey,
} from "./resolve-key.js";
import {
  createManagedMeter,
  ManagedSpendCapExceeded,
  ManagedPaymentBlockedError,
  UnpricedManagedCallError,
  CALL_KINDS,
  type CallKind,
  type ManagedMeter,
} from "./managed-meter.js";
import { providerForModel, priceForModel, type LlmProvider } from "./registry.js";
import { classifyProviderError } from "./provider-error.js";
import { log } from "../log.js";

export { CALL_KINDS, type CallKind };

/** The run a metered call belongs to — an eval run or an optimization run, mirroring
 * ManagedMeter's own RunRef (managed-meter.ts) since it's threaded straight through to it. */
export type MeteredRunRef = { evalRunId: string } | { optRunId: string };

/** The two `ApplicationFailure.type` markers a caller's workflow reads (see the module-header
 * note on why these differ between eval and GEPA). */
export interface MeteredCallTerminals {
  missingKey: string;
  billingBlocked: string;
}

export interface MeteredCallScope {
  supabase: SupabaseClient;
  orgId: string;
  run: MeteredRunRef;
  terminals: MeteredCallTerminals;
}

export interface ResolvedCallModel {
  provider: LlmProvider;
  model: string;
  resolved: ResolvedKey;
}

/** The fixed-model resolution strategy used by 5 of the 6 call sites: the model this call will
 * use is already known (a run's target/reflect/judge model), so derive its provider and resolve
 * the Team's key for it. Only the eval judge picks its own provider (`resolveEvalJudge`, whichever
 * provider the Team has a BYO key for) — that call site passes its own `resolveKey` instead.
 *
 * `provider` (#485): an optimization run with a stored `reflect_provider` passes it explicitly —
 * a live-listed (non-registry) model isn't in the model→provider map, so `providerForModel` would
 * misroute it to Anthropic. Omitted, the registry derivation applies unchanged (old rows,
 * registry models). */
export async function resolveKeyForModel(
  supabase: SupabaseClient,
  orgId: string,
  model: string,
  provider?: LlmProvider
): Promise<ResolvedCallModel> {
  const resolvedProvider = provider ?? providerForModel(model);
  const resolved = await resolveProviderKey(supabase, orgId, resolvedProvider);
  return { provider: resolvedProvider, model, resolved };
}

export interface MeteredContext {
  provider: RuntimeProvider;
  meter: ManagedMeter | undefined;
  providerName: LlmProvider;
  source: "byo" | "managed";
  /** Convenience: record usage against `meter` tagged with this call's role, a no-op when the
   * call is BYO/unmetered (`meter` undefined). Call sites that fan a single ritual out over many
   * provider calls per Activity (the judge's row×criterion chunks in evaluateRun) skip this and
   * pass `meter` straight through instead — evaluateRun does its own per-call record() loop, and
   * duplicating that fan-out here would violate the "one JUDGE_CONCURRENCY fan-out" rule
   * (worker/AGENTS.md). */
  record(usage: TokenUsage | undefined): Promise<void>;
}

function terminalFailure(type: string, message: string): ApplicationFailure {
  return ApplicationFailure.create({ message, type, nonRetryable: true });
}

/** The billing errors that won't clear on retry (and would keep burning managed tokens if
 * retried) — the one shared definition the eval and GEPA paths used to duplicate. */
export function isManagedBillingError(err: unknown): err is Error {
  return (
    err instanceof ManagedSpendCapExceeded ||
    err instanceof ManagedPaymentBlockedError ||
    err instanceof UnpricedManagedCallError
  );
}

/** Convert a known-terminal billing error into the scope's nonRetryable terminal marker; any
 * other error (a provider auth rejection, a DB error, ...) passes through unchanged so Temporal
 * retries it. */
function toBillingTerminal(err: unknown, terminals: MeteredCallTerminals): unknown {
  return isManagedBillingError(err) ? terminalFailure(terminals.billingBlocked, err.message) : err;
}

function runIdAttr(run: MeteredRunRef): { run_id: string } | { opt_run_id: string } {
  return "evalRunId" in run ? { run_id: run.evalRunId } : { opt_run_id: run.optRunId };
}

/** Attribute a failed provider call to the customer's own key when it was BYO (worker/AGENTS.md
 * invariant) — the one definition merging the eval and GEPA paths' twin `logByoEvalKeyFailure` /
 * `logByoOptimizationKeyFailure` helpers. A managed-key failure deliberately stays the generic
 * provider error (no-op here). Never logs key material — only provider, org, run, and the HTTP
 * status/error. */
function logByoKeyFailure(
  err: unknown,
  scope: MeteredCallScope,
  source: "byo" | "managed" | null,
  provider: LlmProvider | null
): void {
  if (source !== "byo" || !provider) return;
  const failure = classifyProviderError(err);
  if (!failure) return;
  log.warn("Customer BYO provider key was rejected by the provider", {
    event: "provider_key.byo_failed",
    provider,
    org_id: scope.orgId,
    ...runIdAttr(scope.run),
    status: failure.status,
    error: err instanceof Error ? err.message : String(err),
  });
}

/** The shared classify step: attribute a BYO rejection, then convert a terminal billing error —
 * always rethrows (the original error when neither applies). Exported for the one call site that
 * can't use `meteredCall`/`runMeteredCall` directly: GEPA's per-instance rollout fan-out, where an
 * `AgentEndpointError` must be re-tagged BEFORE this classification runs (see gepa/activities.ts). */
export function classifyMeteredFailure(
  err: unknown,
  scope: MeteredCallScope,
  ctx: { source: "byo" | "managed" | null; providerName: LlmProvider | null }
): unknown {
  logByoKeyFailure(err, scope, ctx.source, ctx.providerName);
  return toBillingTerminal(err, scope.terminals);
}

export interface ResolveMeteredCallInput {
  scope: MeteredCallScope;
  callKind: CallKind;
  resolveKey: () => Promise<ResolvedCallModel>;
  /** Extra provider-client opts derived from the resolved model (e.g. `{ judgeModel: model }` so
   * the client never calls a different model than the meter priced, #204). Omit for a plain
   * `{ apiKey }` construction. */
  providerOpts?: (model: string) => ProviderOpts;
}

/** Phase 1 of the ritual: resolve the key, fail closed on no key or an unpriced managed model,
 * build the managed meter, and fail closed again if a managed call has no reservation. Returns
 * the ready-to-call provider + meter. Self-classifies its own failure (BYO attribution is a no-op
 * here — none of these are provider-call rejections — but the billing-terminal conversion is
 * not), so a caller that must cache this resolution across many calls (evalrun/activities.ts's
 * per-run `agentContextCache`, resolved once and reused by every per-row Activity) still gets the
 * guard for free without going through `meteredCall`'s single end-to-end call. */
export async function resolveMeteredCall(input: ResolveMeteredCallInput): Promise<MeteredContext> {
  const { scope, callKind, resolveKey, providerOpts } = input;
  let providerName: LlmProvider | null = null;
  let source: "byo" | "managed" | null = null;
  try {
    const resolvedModel = await resolveKey();
    providerName = resolvedModel.provider;
    const { resolved, model } = resolvedModel;
    if (resolved.source === "none") {
      throw terminalFailure(scope.terminals.missingKey, MISSING_PROVIDER_KEY_MESSAGE);
    }
    source = resolved.source;
    const managed = resolved.source === "managed";

    // Fail closed on an unpriced managed model BEFORE any call or reservation lookup — an
    // unpriced managed model must never run (ADR-0008).
    if (managed && !priceForModel(providerName, model)) {
      throw new UnpricedManagedCallError(providerName, model);
    }

    // Build the meter for a managed call only (BYO/Free spends the customer's own tokens and is
    // never metered — meter stays undefined).
    const built = managed ? await createManagedMeter(scope.supabase, scope.orgId, scope.run) : null;

    // Defense-in-depth (#358/#292/#410): a managed call MUST carry a managed-spend reservation
    // made before the run (the app reserves it). A null meter here means no reserve row was
    // found — running would burn spend uncapped and UNMETERED. Enforced uniformly across every
    // call site; there is no opt-out.
    if (managed && built === null) {
      throw terminalFailure(
        scope.terminals.billingBlocked,
        "Managed run has no managed-spend reservation — refusing to run uncapped."
      );
    }

    // Construct the client from the RESOLVED provider, not the model's registry mapping — for a
    // live-listed (non-registry) model (#485) `createProviderForModel` would misroute to the
    // Anthropic client. For every registry model the two are identical (resolveKeyForModel
    // derives its provider from the same map).
    const provider = createProvider(providerName, {
      apiKey: resolved.key,
      ...(providerOpts?.(model) ?? {}),
    });
    const meter = built ?? undefined;
    return {
      provider,
      meter,
      providerName,
      source: resolved.source as "byo" | "managed",
      record: (usage) => (meter ? meter.record({ usage, callKind }) : Promise.resolve()),
    };
  } catch (err) {
    throw classifyMeteredFailure(err, scope, { source, providerName });
  }
}

export interface MeteredCallInput<T> extends ResolveMeteredCallInput {
  execute: (ctx: MeteredContext) => Promise<T>;
}

/** The full ritual in one call: resolve -> guard -> execute -> classify. The one-line adoption
 * for 5 of the 6 call sites (eval judge; GEPA's rollout judge, reflection propose, and Simple
 * Mode generation). The 6th (eval's per-row Managed Agent target invocation) uses
 * `resolveMeteredCall` + `runMeteredCall` split across its per-run cache instead — see
 * evalrun/activities.ts. */
export async function meteredCall<T>(input: MeteredCallInput<T>): Promise<T> {
  const ctx = await resolveMeteredCall(input); // already-classified on its own failure
  return runMeteredCall(input.scope, ctx, input.execute);
}

/** Phase 2 standalone, for a caller that already resolved (and cached) its `MeteredContext` via
 * `resolveMeteredCall`. Still centralizes the classify step so a cached call site can't skip it. */
export async function runMeteredCall<T>(
  scope: MeteredCallScope,
  ctx: MeteredContext,
  execute: (ctx: MeteredContext) => Promise<T>
): Promise<T> {
  try {
    return await execute(ctx);
  } catch (err) {
    throw classifyMeteredFailure(err, scope, ctx);
  }
}
