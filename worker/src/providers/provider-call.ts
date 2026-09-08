// The provider-call protocol, in one seam (#384, ADR-0020). Every LLM call a run makes — the
// eval judge, a Managed Agent's target, GEPA's rollout judge, reflection propose, and Simple
// Mode generation — resolves a provider key, fails closed if there is none, builds the provider
// client, and classifies whatever the call throws. That ritual used to be duplicated at each
// call site; this module is the one interface a new call site can't forget a guard through.
//
// Nothing is metered: both key sources (a saved Vault key, or the operator's env var) are the
// operator's own key, and token costs go straight to the provider.
//
// One eval-run vs optimization-run divergence is preserved on purpose: the two workflows
// classify a terminal Activity failure by DIFFERENT `ApplicationFailure` `type` markers (eval
// folds every terminal reason into one "EvalRunTerminal" marker; GEPA's circuit breaker —
// gepa/circuit-breaker.ts — branches on distinct markers per failure class).
// `ProviderCallTerminals` carries whichever pair the caller's workflow reads.
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApplicationFailure } from "@temporalio/common";
import { createProvider, type ProviderOpts } from "./factory.js";
import type { RuntimeProvider } from "./llm.js";
import {
  resolveProviderKey,
  MISSING_PROVIDER_KEY_MESSAGE,
  type ResolvedKey,
} from "./resolve-key.js";
import { providerForModel, PROVIDER_LABELS, type LlmProvider } from "./registry.js";
import { classifyProviderError } from "./provider-error.js";
import { log } from "../log.js";

/** The run a provider call belongs to — an eval run or an optimization run. */
export type ProviderRunRef = { evalRunId: string } | { optRunId: string };

/** The `ApplicationFailure.type` markers a caller's workflow reads (see the module-header note on
 * why these differ between eval and GEPA). `modelUnavailable` is stamped when a provider answers a
 * model call with a model-not-found status (a retired live-listed model, #485/#488) — GEPA gives
 * it its own marker so the loop's `isTerminalRunFailure` re-throws it; eval folds it into the one
 * "EvalRunTerminal" marker like every other terminal reason. */
export interface ProviderCallTerminals {
  missingKey: string;
  modelUnavailable: string;
}

export interface ProviderCallScope {
  supabase: SupabaseClient;
  orgId: string;
  run: ProviderRunRef;
  terminals: ProviderCallTerminals;
}

export interface ResolvedCallModel {
  provider: LlmProvider;
  model: string;
  resolved: ResolvedKey;
}

/** The fixed-model resolution strategy used by 5 of the 6 call sites: the model this call will
 * use is already known (a run's target/reflect/judge model), so derive its provider and resolve
 * the Workspace's key for it. Only the eval judge picks its own provider (`resolveEvalJudge`,
 * whichever provider has a key) — that call site passes its own `resolveKey` instead.
 *
 * `provider` (#485): an optimization run with a stored `reflect_provider` passes it explicitly —
 * a live-listed (non-registry) model isn't in the model→provider map, so `providerForModel` would
 * misroute it to Anthropic. Omitted, the registry derivation applies unchanged. */
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

export type KeySource = "byo" | "env";

export interface ProviderCallContext {
  provider: RuntimeProvider;
  providerName: LlmProvider;
  source: KeySource;
}

function terminalFailure(type: string, message: string): ApplicationFailure {
  return ApplicationFailure.create({ message, type, nonRetryable: true });
}

function runIdAttr(run: ProviderRunRef): { run_id: string } | { opt_run_id: string } {
  return "evalRunId" in run ? { run_id: run.evalRunId } : { opt_run_id: run.optRunId };
}

/** Provider HTTP statuses that genuinely implicate the KEY: an auth/authorization rejection
 * (401/403) or a quota exhaustion (429). A 400/404 (bad request / model-not-found) or a 5xx
 * (provider-side blip) does NOT — attributing those to the key would, for a live-listed model the
 * provider retired between run creation and execution (#485), blame the key for catalog drift
 * with a false `provider_key.byo_failed` (#488). */
const KEY_REJECTION_STATUSES = new Set([401, 403, 429]);
function isKeyRejectionStatus(status: number | null): boolean {
  return status != null && KEY_REJECTION_STATUSES.has(status);
}

/** Provider HTTP statuses that mean the requested MODEL is gone: a 404 (not found) or a 400 (bad
 * request — the shape a couple of providers return for an unknown model id). In practice this is a
 * live-listed model (#485) the provider retired between run creation and execution, so the id
 * every retry sends is permanently gone — a client error, never a transient blip. Convert it to a
 * nonRetryable terminal (#488) so the run fails fast with a comprehensible reason. */
const MODEL_NOT_FOUND_STATUSES = new Set([400, 404]);
function isModelNotFoundStatus(status: number | null): boolean {
  return status != null && MODEL_NOT_FOUND_STATUSES.has(status);
}

function modelUnavailableMessage(provider: LlmProvider | null): string {
  const label = provider ? PROVIDER_LABELS[provider] : "the provider";
  return (
    `The selected model is no longer available from ${label}. ` +
    "Pick a different model and start a new run."
  );
}

/** Convert a provider model-not-found rejection into the scope's nonRetryable `modelUnavailable`
 * terminal, or null when the error isn't one. Prefers the provider named on the failure, falling
 * back to the call's known provider. */
function toModelUnavailableTerminal(
  err: unknown,
  terminals: ProviderCallTerminals,
  provider: LlmProvider | null
): ApplicationFailure | null {
  const failure = classifyProviderError(err);
  if (!failure || !isModelNotFoundStatus(failure.status)) return null;
  return terminalFailure(
    terminals.modelUnavailable,
    modelUnavailableMessage(failure.provider ?? provider)
  );
}

/** Attribute a failed provider call to the Workspace's key (worker/AGENTS.md invariant). A
 * non-key failure (a retired/unknown MODEL, a provider outage) is not attributed to the key — only
 * a genuine key-rejection status is (see above). Never logs key material — only provider, org,
 * run, source, and the HTTP status/error. */
function logKeyFailure(
  err: unknown,
  scope: ProviderCallScope,
  source: KeySource | null,
  provider: LlmProvider | null
): void {
  if (!source || !provider) return;
  const failure = classifyProviderError(err);
  if (!failure || !isKeyRejectionStatus(failure.status)) return;
  log.warn("Provider key was rejected by the provider", {
    event: "provider_key.byo_failed",
    provider,
    key_source: source,
    org_id: scope.orgId,
    ...runIdAttr(scope.run),
    status: failure.status,
    error: err instanceof Error ? err.message : String(err),
  });
}

/** The shared classify step: attribute a key rejection, then convert a retired model into its
 * terminal — always rethrows (the original error when neither applies). Exported for the one call
 * site that can't use `providerCall`/`runProviderCall` directly: GEPA's per-instance rollout
 * fan-out, where an `AgentEndpointError` must be re-tagged BEFORE this classification runs. */
export function classifyProviderFailure(
  err: unknown,
  scope: ProviderCallScope,
  ctx: { source: KeySource | null; providerName: LlmProvider | null }
): unknown {
  logKeyFailure(err, scope, ctx.source, ctx.providerName);
  return toModelUnavailableTerminal(err, scope.terminals, ctx.providerName) ?? err;
}

export interface ResolveProviderCallInput {
  scope: ProviderCallScope;
  resolveKey: () => Promise<ResolvedCallModel>;
  /** Extra provider-client opts derived from the resolved model (e.g. `{ judgeModel: model }` so
   * the client never calls a different model than the one resolved, #204). Omit for a plain
   * `{ apiKey }` construction. */
  providerOpts?: (model: string) => ProviderOpts;
}

/** Phase 1: resolve the key, fail closed on no key, and build the provider client. Self-
 * classifies its own failure so a caller that must cache this resolution across many calls
 * (evalrun/activities.ts's per-run `agentContextCache`, resolved once and reused by every per-row
 * Activity) still gets the guard for free without going through `providerCall`'s single
 * end-to-end call. */
export async function resolveProviderCall(
  input: ResolveProviderCallInput
): Promise<ProviderCallContext> {
  const { scope, resolveKey, providerOpts } = input;
  let providerName: LlmProvider | null = null;
  let source: KeySource | null = null;
  try {
    const resolvedModel = await resolveKey();
    providerName = resolvedModel.provider;
    const { resolved, model } = resolvedModel;
    if (resolved.source === "none") {
      throw terminalFailure(scope.terminals.missingKey, MISSING_PROVIDER_KEY_MESSAGE);
    }
    source = resolved.source;
    // Construct the client from the RESOLVED provider, not the model's registry mapping — for a
    // live-listed (non-registry) model (#485) `createProviderForModel` would misroute to the
    // Anthropic client. For every registry model the two are identical.
    const provider = createProvider(providerName, {
      apiKey: resolved.key,
      ...(providerOpts?.(model) ?? {}),
    });
    return { provider, providerName, source };
  } catch (err) {
    throw classifyProviderFailure(err, scope, { source, providerName });
  }
}

export interface ProviderCallInput<T> extends ResolveProviderCallInput {
  execute: (ctx: ProviderCallContext) => Promise<T>;
}

/** The full ritual in one call: resolve → guard → execute → classify. */
export async function providerCall<T>(input: ProviderCallInput<T>): Promise<T> {
  const ctx = await resolveProviderCall(input); // already-classified on its own failure
  return runProviderCall(input.scope, ctx, input.execute);
}

/** Phase 2 standalone, for a caller that already resolved (and cached) its context via
 * `resolveProviderCall`. Still centralizes the classify step so a cached call site can't skip it. */
export async function runProviderCall<T>(
  scope: ProviderCallScope,
  ctx: ProviderCallContext,
  execute: (ctx: ProviderCallContext) => Promise<T>
): Promise<T> {
  try {
    return await execute(ctx);
  } catch (err) {
    throw classifyProviderFailure(err, scope, ctx);
  }
}
