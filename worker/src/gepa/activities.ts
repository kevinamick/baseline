// GEPA optimization Activities (ADR-0006). All Postgres access for an Optimization Run
// lives here: the Workflow carries only IDs, and these Activities read the real prompts /
// frozen instances and write rollouts / results back. Registered into the Temporal worker
// by re-export from temporal/activities.ts. This is plain Node — no sandbox constraints.

import { createClient } from "@supabase/supabase-js";
import { log } from "../log.js";
import { setLogContext } from "../log-context.js";
import { ApplicationFailure } from "@temporalio/common";
import { createProviderForModel } from "../providers/factory.js";
import type { RuntimeProvider } from "../providers/llm.js";
import {
  resolveProviderKey,
  MISSING_PROVIDER_KEY_MESSAGE,
} from "../providers/resolve-key.js";
import { classifyProviderError } from "../providers/provider-error.js";
import {
  providerForModel,
  isAnthropicModel,
  defaultJudgeModelForProvider,
  type LlmProvider,
} from "../providers/registry.js";
import {
  createManagedMeter,
  ManagedSpendCapExceeded,
  ManagedPaymentBlockedError,
  UnpricedManagedCallError,
  type ManagedMeter,
} from "../providers/managed-meter.js";
import type { ReflectionExample } from "../providers/llm.js";
import { evaluateRun, type Rubric } from "../evaluator.js";
import { mapWithConcurrency } from "../concurrency.js";
import {
  AgentEndpointError,
  invokeAgent,
  invokeManagedAgent,
  type AgentConnection,
} from "../agent.js";
import { perInstanceScores, seedPromptsFor } from "./scoring.js";
import { MINIBATCH, type RolloutPhase } from "./phase.js";
import { selectOperator, buildRewriteMessages } from "../simple/operators.js";
import { extractProposedPrompt } from "../providers/reflect.js";
import {
  AGENT_ENDPOINT_ERROR_TYPE,
  MANAGED_AGENT_CONFIG_TYPE,
  MANAGED_SPEND_BLOCKED_TYPE,
  PROVIDER_KEY_MISSING_TYPE,
} from "./circuit-breaker.js";
import {
  sendOptimizationCompletionEmail,
  sendOptimizationFailureEmail,
  sendOptimizationPausedEmail,
} from "../optimization-emailer.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Base URL for the run's deep link in terminal-state emails. Mirrors the eval worker's APP_URL.
const APP_URL = process.env.APP_URL ?? "https://baseline.app";

// In-run rollout parallelism cap (D12): agent invocations within a single rollout fan out up to
// this many at a time. Bounds load on the customer endpoint and respects Anthropic rate limits
// while still being far faster than one-at-a-time over a 50-instance Pareto set.
const ROLLOUT_CONCURRENCY = 5;

// Heartbeat: bump the run's updated_at so the stale-run reaper (#90) can tell a live run (an
// Activity touched it recently) from a stranded one (worker crashed mid-run). Best-effort —
// a failed heartbeat must never fail the rollout it precedes.
async function touchOptimizationRun(optRunId: string): Promise<void> {
  await supabase
    .from("optimization_runs")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", optRunId);
}

// Same column set the eval worker loads, plus optimizable_prompts so the agent invoker can
// resolve {{prompt:<module>}} from a Candidate's map (or each Module's seed).
const CONNECTION_COLUMNS =
  "id, kind, agent_kind, provider, endpoint, auth_header, auth_secret_id, request_template, response_path, target_model, optimizable_prompts";

// ---- Activities ----

export interface SeedRunResult {
  candidateId: string;
  instanceCount: number;
  // The Connection's declared Module names, in declaration order. The workflow round-robins
  // its mutation target through these; empty for a {{user_input}}-only agent.
  modules: string[];
  // Termination knobs (D8), carried back so the workflow loop never re-reads the run row.
  // budgetRollouts is the primary ceiling (max agent invocations); max_iters and the optional
  // plateau_patience are backstops.
  budgetRollouts: number;
  maxIters: number;
  plateauPatience: number | null;
  // Pause-and-wait knobs (#102): how long a run may sit paused on an endpoint outage before
  // giving up, and the initial delay before the first health probe (the workflow backs off
  // from there).
  pauseMaxWaitMinutes: number;
  probeIntervalSeconds: number;
}

// Seed Candidate 0 from the Connection's Module seeds and mark the run running. Idempotent:
// a retried Activity returns the existing generation-0 Candidate rather than inserting a
// duplicate (the partial work of an earlier attempt is reused, not redone).
export async function seedRun(optRunId: string): Promise<SeedRunResult> {
  const run = await loadRun(optRunId);
  const connection = await loadConnection(run.connection_id);
  const modules = (connection.optimizable_prompts ?? []).map((m) => m.name);

  const { error: statusErr } = await supabase
    .from("optimization_runs")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", optRunId);
  if (statusErr)
    throw new Error(
      `Failed to mark optimization run as running: ${statusErr.message}`,
    );

  const { count, error: countErr } = await supabase
    .from("optimization_inputs")
    .select("id", { count: "exact", head: true })
    .eq("opt_run_id", optRunId);
  if (countErr)
    throw new Error(
      `Failed to count optimization instances: ${countErr.message}`,
    );
  const instanceCount = count ?? 0;

  // Structured lifecycle-start event, the optimization-run parallel to `eval_run.dequeued`
  // (worker.ts): it brackets the run against the later `optimization_run.completed/failed`
  // terminal logs so a run's full lifecycle — and queue-to-completion latency — is queryable
  // in PostHog Logs. opt_run_id/org_id are already auto-stamped by the Activity log-context
  // interceptor; opt_run_id is passed explicitly for parity with the terminal logs.
  log.info("Optimization run started", {
    event: "optimization_run.started",
    opt_run_id: optRunId,
    module_count: modules.length,
    instance_count: instanceCount,
    budget_rollouts: run.budget_rollouts,
    max_iters: run.max_iters,
  });

  const termination = {
    budgetRollouts: run.budget_rollouts,
    maxIters: run.max_iters,
    plateauPatience: run.plateau_patience,
    pauseMaxWaitMinutes: run.pause_max_wait_minutes,
    probeIntervalSeconds: run.probe_interval_seconds,
  };

  const { data: existing, error: existingError } = await supabase
    .from("optimization_candidates")
    .select("id")
    .eq("opt_run_id", optRunId)
    .eq("generation", 0)
    .maybeSingle();
  if (existingError)
    throw new Error(
      `Failed to check existing seed candidate: ${existingError.message}`,
    );
  if (existing)
    return { candidateId: existing.id, instanceCount, modules, ...termination };

  const { data: candidate, error } = await supabase
    .from("optimization_candidates")
    .insert({
      opt_run_id: optRunId,
      parent_id: null,
      generation: 0,
      prompts: seedPromptsFor(connection.optimizable_prompts),
    })
    .select("id")
    .single();
  if (error || !candidate)
    throw new Error(`Failed to seed candidate: ${error?.message}`);

  return { candidateId: candidate.id, instanceCount, modules, ...termination };
}

export interface RolloutInput {
  optRunId: string;
  candidateId: string;
  phase: RolloutPhase;
  // For the "minibatch" accept/reject test, score only the first `limit` instances (ordered
  // by instance_index). Omitted for "pareto", which scores the full frozen set. Because the
  // ordering is stable, parent and child are always tested on the same minibatch instances.
  limit?: number;
}

export interface RolloutResult {
  overallScore: number;
  instanceScores: Record<number, number>;
  // Agent invocations this rollout actually made (= instances scored). The workflow sums
  // these into rollouts_used to enforce the budget ceiling, rather than guessing from limit.
  instancesRun: number;
}

// Run one Candidate across the frozen instance set: invoke the agent per instance with the
// Candidate's prompts, persist each rollout + per-criterion judge result, and return the
// overall + per-instance score vector. Upserts make this safe to retry.
export async function rolloutCandidate(
  input: RolloutInput,
): Promise<RolloutResult> {
  const { optRunId, candidateId, phase, limit } = input;
  await touchOptimizationRun(optRunId); // heartbeat for the stale-run reaper
  const run = await loadRun(optRunId);
  const connection = await loadConnection(run.connection_id);
  const rubric = await loadRubric(run.rubric_id);
  const authValue = await getAuthValue(connection.auth_secret_id);
  const prompts = await loadCandidatePrompts(candidateId);

  // Managed Agent (#290): the System is Baseline's managed LLM, so rollouts call it directly
  // rather than a customer endpoint. Resolve the Team's key for the target model once and build
  // a host-pinned provider (#222) for the whole rollout. (resolveOptimizationKey fails closed if
  // the Team has no key.)
  const managed = connection.agent_kind === "managed";
  if (
    managed &&
    (!connection.target_model || !isAnthropicModel(connection.target_model))
  ) {
    // Terminal, not retryable: an unknown/missing target_model would otherwise resolve a key
    // and POST it to the provider with an invalid model, hard-erroring once per instance and
    // retrying the Activity to its cap on a config typo. The wizard (#293) validates the model
    // on save; this is the worker's fail-closed backstop. (providerForModel returns 'anthropic'
    // for anything, so the key/host pin can't catch a bad model — only this can.)
    throw ApplicationFailure.create({
      type: MANAGED_AGENT_CONFIG_TYPE,
      message: `Managed Agent has an invalid or missing target_model: ${connection.target_model ?? "(none)"}`,
      nonRetryable: true,
    });
  }
  let managedCompleter: RuntimeProvider | null = null;
  let agentMeter: ManagedMeter | null = null;
  // The target key's source + provider, hoisted so the per-instance catch below can attribute a
  // provider rejection of a BYO target key to the customer (provider_key.byo_failed). null until a
  // managed target resolves (an external-agent rollout uses no LLM key for its endpoint call).
  let targetKeySource: "byo" | "managed" | null = null;
  const targetProvider = managed
    ? providerForModel(connection.target_model!)
    : null;
  if (managed) {
    const targetKey = await resolveOptimizationKey(
      run.org_id,
      connection.target_model!,
    );
    targetKeySource = targetKey.source;
    // The factory picks the client for the target model's provider; the target key was resolved
    // for that same provider (resolveOptimizationKey derives it via providerForModel), so a
    // non-Anthropic managed target would use its own provider's key (#204).
    managedCompleter = createProviderForModel(connection.target_model!, {
      apiKey: targetKey.key,
    });
    // The target-model rollout is now the dominant managed-spend term (#291): bill it at the
    // Plan markup when it runs on the managed key. A BYO key for the provider resolves to "byo"
    // → null meter → unmetered (the customer's own tokens), exactly mirroring the judge path and
    // resolve-key. An unpriced target model fails closed terminally (assertPriced), not a
    // retry-forever, so a bad model can't burn the Activity's retries.
    try {
      agentMeter = await optimizationMeter(
        run.org_id,
        optRunId,
        targetKey.source,
        connection.target_model!,
      );
    } catch (err) {
      rethrowManagedAsTerminal(err);
    }
    // Defense-in-depth (#204, mirrors the eval path's guard): a managed target MUST carry a
    // managed-spend reservation (the app reserves it at run creation). A null meter when the
    // target resolved to the managed key means no reserve row was found — running would burn the
    // dominant target-model spend uncapped/unmetered, so fail closed terminally (not retry-forever)
    // rather than silently. A BYO-keyed target resolves to source "byo" and is legitimately null.
    if (targetKey.source === "managed" && agentMeter === null) {
      throw ApplicationFailure.create({
        type: MANAGED_SPEND_BLOCKED_TYPE,
        message: `Managed Agent optimization run ${optRunId} has no managed-spend reservation — refusing to run uncapped.`,
        nonRetryable: true,
      });
    }
  }

  let query = supabase
    .from("optimization_inputs")
    .select("instance_index, user_input, expected_output, retrieval_context")
    .eq("opt_run_id", optRunId)
    .order("instance_index", { ascending: true });
  if (limit !== undefined) query = query.limit(limit);
  const { data: instances, error: instErr } = await query;
  if (instErr) throw new Error(`Failed to load instances: ${instErr.message}`);
  if (!instances?.length)
    throw new Error("No frozen instances for optimization run");

  // Invoke + persist each instance, fanning out up to ROLLOUT_CONCURRENCY at a time. Results
  // come back in instance order so the evaluator scores a stable row order (parent and child
  // see the same minibatch).
  const settled = await mapWithConcurrency(
    instances,
    ROLLOUT_CONCURRENCY,
    async (inst) => {
      let agentOutput: string;
      const invokableRow = {
        row_index: inst.instance_index,
        user_input: inst.user_input,
        expected_output: inst.expected_output,
        retrieval_context: inst.retrieval_context,
      };
      try {
        if (managed) {
          const { text, usage } = await invokeManagedAgent(
            connection,
            invokableRow,
            managedCompleter!,
            prompts,
          );
          agentOutput = text;
          // Meter the target-model tokens (null meter = BYO/unmetered). record() is atomic
          // per-org in the DB, so concurrent rollouts serialize safely and the cap check sees a
          // running total; it throws ManagedSpendCapExceeded the instant the cap is reached.
          if (agentMeter) await agentMeter.record({ usage, callKind: "agent" });
        } else {
          agentOutput = await invokeAgent(
            connection,
            invokableRow,
            authValue,
            prompts,
          );
        }
      } catch (err) {
        // Re-tag a customer-endpoint failure so the cross-Activity boundary carries a stable
        // `type` the workflow's circuit breaker recognizes (#90). Retryable so a transient blip
        // still gets the capped retries; a sustained outage trips the breaker upstream.
        if (err instanceof AgentEndpointError) {
          throw ApplicationFailure.create({
            type: AGENT_ENDPOINT_ERROR_TYPE,
            message: err.message,
          });
        }
        // A Managed Agent target call on the Team's own key that the provider rejects is the
        // customer's BYO key failing — log it distinctly before rethrowing (no-op for managed/none).
        if (targetKeySource && targetProvider) {
          logByoOptimizationKeyFailure(err, {
            source: targetKeySource,
            provider: targetProvider,
            orgId: run.org_id,
            optRunId,
          });
        }
        // A managed cap breach / unpriced model from target-model metering (#291) is terminal —
        // convert it to a non-retryable failure so the run stops the instant accrued spend reaches
        // the cap (mid-rollout) instead of retrying the Activity forever. Anything else rethrows.
        rethrowManagedAsTerminal(err);
      }

      const { data: rollout, error: rErr } = await supabase
        .from("optimization_rollouts")
        .upsert(
          {
            candidate_id: candidateId,
            instance_index: inst.instance_index,
            phase,
            agent_output: agentOutput,
          },
          { onConflict: "candidate_id,instance_index,phase" },
        )
        .select("id")
        .single();
      if (rErr || !rollout)
        throw new Error(`Failed to persist rollout: ${rErr?.message}`);

      return {
        rolloutId: rollout.id as string,
        row: {
          row_index: inst.instance_index,
          user_input: inst.user_input,
          agent_output: agentOutput,
          expected_output: inst.expected_output,
          retrieval_context: inst.retrieval_context,
        },
      };
    },
  );

  const rows: Parameters<typeof evaluateRun>[1] = settled.map((s) => s.row);
  const rolloutIdByInstance: Record<number, string> = {};
  for (const s of settled) rolloutIdByInstance[s.row.row_index] = s.rolloutId;

  // A run is single-provider: the judge runs on the same provider as the run's reflect model
  // (#204), using that provider's default judge model and the Team's key for that provider. So a
  // run with an OpenAI/Google reflect model judges on OpenAI/Google too, driven by the same key
  // (Anthropic keeps its ANTHROPIC_MODEL env override). The factory picks the client by model.
  const judgeModel = defaultJudgeModelForProvider(
    providerForModel(run.reflect_model),
  );
  const judgeProvider = providerForModel(judgeModel);
  const resolved = await resolveOptimizationKey(run.org_id, judgeModel);
  const provider = createProviderForModel(judgeModel, {
    apiKey: resolved.key,
    judgeModel,
  });
  let meter: ManagedMeter | null = null;
  try {
    meter = await optimizationMeter(
      run.org_id,
      optRunId,
      resolved.source,
      judgeModel,
    );
  } catch (err) {
    rethrowManagedAsTerminal(err);
  }
  let results: Awaited<ReturnType<typeof evaluateRun>>["results"];
  let overallScore: number;
  try {
    ({ results, overallScore } = await evaluateRun(
      rubric,
      rows,
      provider,
      run.eval_type,
      meter ?? undefined,
    ));
  } catch (err) {
    // A judge call the provider rejects on the Team's own key is the customer's BYO key failing.
    logByoOptimizationKeyFailure(err, {
      source: resolved.source,
      provider: judgeProvider,
      orgId: run.org_id,
      optRunId,
    });
    // A managed cap breach / unpriced model is terminal — don't retry forever.
    rethrowManagedAsTerminal(err);
  }

  const { error: resErr } = await supabase.from("rollout_results").upsert(
    results.map((r) => ({
      rollout_id: rolloutIdByInstance[r.rowIndex],
      criterion_name: r.criterionName,
      score: r.score,
      reasoning: r.reasoning,
    })),
    { onConflict: "rollout_id,criterion_name" },
  );
  if (resErr)
    throw new Error(`Failed to persist rollout results: ${resErr.message}`);

  return {
    overallScore,
    instanceScores: perInstanceScores(results, rubric.criteria),
    instancesRun: instances.length,
  };
}

export interface ProposeCandidateInput {
  optRunId: string;
  parentCandidateId: string;
  targetModule: string;
  // The loop's 1-based iteration counter, unique within the run. It's the child's stable
  // identity, so a retried Activity returns the existing child instead of reflecting again.
  iteration: number;
}

export interface ProposeCandidateResult {
  childCandidateId: string;
}

// Reflective mutation (#88): read the parent's minibatch feedback, ask the reflection model
// for a better prompt for one Module, and persist a child Candidate (parent's prompts with
// that Module replaced). The child isn't scored here — the workflow rolls it out and decides
// whether to accept it.
//
// Idempotent via `iteration` (#89): the reflection call is non-deterministic and the Activity
// is at-least-once, so we first look up the child already persisted for this iteration. A
// retry after the insert returns it without re-spending a reflection call; a retry before the
// insert re-reflects once, and the (opt_run_id, iteration) unique index backstops a race.
export async function proposeCandidate(
  input: ProposeCandidateInput,
): Promise<ProposeCandidateResult> {
  const { optRunId, parentCandidateId, targetModule, iteration } = input;
  await touchOptimizationRun(optRunId); // heartbeat for the stale-run reaper

  const { data: existing, error: existingError } = await supabase
    .from("optimization_candidates")
    .select("id")
    .eq("opt_run_id", optRunId)
    .eq("iteration", iteration)
    .maybeSingle();
  if (existingError)
    throw new Error(
      `Failed to check existing candidate: ${existingError.message}`,
    );
  if (existing) return { childCandidateId: existing.id };

  const run = await loadRun(optRunId);
  const parent = await loadCandidate(parentCandidateId);
  const examples = await loadMinibatchFeedback(optRunId, parentCandidateId);

  const resolved = await resolveOptimizationKey(run.org_id, run.reflect_model);
  const provider = createProviderForModel(run.reflect_model, {
    apiKey: resolved.key,
    reflectModel: run.reflect_model,
  });
  let meter: ManagedMeter | null = null;
  try {
    meter = await optimizationMeter(
      run.org_id,
      optRunId,
      resolved.source,
      run.reflect_model,
    );
  } catch (err) {
    rethrowManagedAsTerminal(err);
  }
  let newPrompt: string;
  try {
    const proposed = await provider.propose({
      targetModule,
      currentPrompt: parent.prompts[targetModule] ?? "",
      examples,
    });
    // Meter the reflection call's actual tokens; a cap breach throws here.
    if (meter)
      await meter.record({ usage: proposed.usage, callKind: "reflect" });
    newPrompt = proposed.prompt;
  } catch (err) {
    // A reflection call the provider rejects on the Team's own key is the customer's BYO key failing.
    logByoOptimizationKeyFailure(err, {
      source: resolved.source,
      provider: providerForModel(run.reflect_model),
      orgId: run.org_id,
      optRunId,
    });
    rethrowManagedAsTerminal(err);
  }

  const { data: child, error } = await supabase
    .from("optimization_candidates")
    .insert({
      opt_run_id: optRunId,
      parent_id: parentCandidateId,
      generation: parent.generation + 1,
      iteration,
      target_module: targetModule,
      prompts: { ...parent.prompts, [targetModule]: newPrompt },
    })
    .select("id")
    .single();
  if (error || !child) {
    // A concurrent/retried attempt may have inserted this iteration's child first
    // (the (opt_run_id, iteration) unique index). Re-read and return it before failing,
    // so the race converges on the one persisted child instead of failing the run.
    const { data: raced } = await supabase
      .from("optimization_candidates")
      .select("id")
      .eq("opt_run_id", optRunId)
      .eq("iteration", iteration)
      .maybeSingle();
    if (raced) return { childCandidateId: raced.id };
    throw new Error(`Failed to persist child candidate: ${error?.message}`);
  }

  return { childCandidateId: child.id };
}

export interface ProposeSimpleCandidateInput {
  optRunId: string;
  parentCandidateId: string;
  targetModule: string;
  // The round number, stored as the child's generation (the seed is round 0). Simple Mode
  // makes N Candidates per round, so generation groups a round rather than tracking lineage depth.
  round: number;
  // The per-Candidate sequence (unique within the run) — the child's idempotency key, exactly
  // like proposeCandidate's iteration.
  iteration: number;
  // A [0,1) draw sourced in the workflow (replay-safe) selecting the rewrite operator.
  operatorSeed: number;
}

// Simple Mode candidate generation (#316, ADR-0015): apply a rewrite operator to the parent
// elite's prompt via the generation model and persist a child Candidate. Unlike GEPA's
// proposeCandidate it reads NO minibatch feedback — Simple Mode concentrates on score alone, so
// the model sees only the current prompt and the operator instruction. The child isn't scored
// here; the workflow rolls it out on the full set and selects elites.
//
// Idempotent via `iteration` (same contract as proposeCandidate): the generation call is
// non-deterministic and the Activity is at-least-once, so we first return any child already
// persisted for this iteration, and the (opt_run_id, iteration) unique index backstops a race.
export async function proposeSimpleCandidate(
  input: ProposeSimpleCandidateInput,
): Promise<ProposeCandidateResult> {
  const {
    optRunId,
    parentCandidateId,
    targetModule,
    round,
    iteration,
    operatorSeed,
  } = input;
  await touchOptimizationRun(optRunId); // heartbeat for the stale-run reaper

  const { data: existing, error: existingError } = await supabase
    .from("optimization_candidates")
    .select("id")
    .eq("opt_run_id", optRunId)
    .eq("iteration", iteration)
    .maybeSingle();
  if (existingError)
    throw new Error(
      `Failed to check existing candidate: ${existingError.message}`,
    );
  if (existing) return { childCandidateId: existing.id };

  const run = await loadRun(optRunId);
  const parent = await loadCandidate(parentCandidateId);

  // The generation model is stored in reflect_model (the column that records "the model that
  // proposes the next prompt"); Simple Mode defaults it to Haiku at run creation. It runs on the
  // Team's key and is metered like a reflection call.
  const resolved = await resolveOptimizationKey(run.org_id, run.reflect_model);
  const provider = createProviderForModel(run.reflect_model, {
    apiKey: resolved.key,
  });
  let meter: ManagedMeter | null = null;
  try {
    meter = await optimizationMeter(
      run.org_id,
      optRunId,
      resolved.source,
      run.reflect_model,
    );
  } catch (err) {
    rethrowManagedAsTerminal(err);
  }

  const operator = selectOperator(operatorSeed);
  const { system, user } = buildRewriteMessages(
    operator,
    parent.prompts[targetModule] ?? "",
  );

  let newPrompt: string;
  try {
    const { text, usage } = await provider.complete({
      // Simple Mode generates a full prompt rewrite (like reflection), and its non-Anthropic
      // defaults are reasoning models (gpt-5-mini, gemini-2.5-flash) whose reasoning/thinking
      // tokens are spent from the output budget before any visible text — a tight cap would be
      // consumed by reasoning and return empty, throwing below. Give it the same headroom the
      // reflection path uses (#204).
      model: run.reflect_model,
      system,
      user,
      maxTokens: 8192,
    });
    // Meter the generation call's actual tokens; a cap breach throws here. callKind 'reflect'
    // is the existing bucket for a prompt-proposer call (Simple has no distinct kind).
    if (meter) await meter.record({ usage, callKind: "reflect" });
    const extracted = extractProposedPrompt(text);
    // A model that returns nothing usable shouldn't install an empty prompt; surface it so the
    // workflow logs the failed variant and moves on rather than scoring an empty Candidate.
    if (!extracted)
      throw new Error("Generation model returned an empty prompt");
    newPrompt = extracted;
  } catch (err) {
    // A generation call the provider rejects on the Team's own key is the customer's BYO key failing.
    logByoOptimizationKeyFailure(err, {
      source: resolved.source,
      provider: providerForModel(run.reflect_model),
      orgId: run.org_id,
      optRunId,
    });
    rethrowManagedAsTerminal(err);
  }

  const { data: child, error } = await supabase
    .from("optimization_candidates")
    .insert({
      opt_run_id: optRunId,
      parent_id: parentCandidateId,
      generation: round,
      iteration,
      target_module: targetModule,
      prompts: { ...parent.prompts, [targetModule]: newPrompt },
    })
    .select("id")
    .single();
  if (error || !child) {
    const { data: raced } = await supabase
      .from("optimization_candidates")
      .select("id")
      .eq("opt_run_id", optRunId)
      .eq("iteration", iteration)
      .maybeSingle();
    if (raced) return { childCandidateId: raced.id };
    throw new Error(
      `Failed to persist simple child candidate: ${error?.message}`,
    );
  }

  return { childCandidateId: child.id };
}

// Run lifetime in ms for a terminal log event, measured from the run's `created_at`. Optimization
// runs span many Activities under per-Activity log scopes (temporal/activity-log-context.ts), so
// there is no run-wide `started_at_ms` to read the way eval runs do (worker/src/log-context.ts) —
// the row's creation time is the available anchor (queue time before the workflow starts is brief,
// since at most one run is active per org). Returns undefined for a missing/unparseable value so
// flattenAttributes simply omits the key.
function durationMsSince(
  createdAt: string | null | undefined,
): number | undefined {
  if (!createdAt) return undefined;
  const started = Date.parse(createdAt);
  if (Number.isNaN(started)) return undefined;
  return Date.now() - started;
}

export interface CompleteRunInput {
  optRunId: string;
  bestCandidateId: string;
  overallScore: number;
  // Seed (Candidate 0) full-set overall score, carried from the workflow. best_score and this
  // share the workflow's Pareto-eval metric, so seed -> best is an apples-to-apples lift.
  seedScore: number;
  // Agent invocations spent across the run, for the completion email's "rollouts spent".
  rolloutsUsed: number;
}

// Settle the run's allowance unit (#181) and, for an overage run, its Eval Point
// reservation (ADR-0016). Both are idempotent in Postgres and a no-op for the
// meter this run didn't use (within-allowance runs hold no point reserve; overage
// runs hold no unit reserve). Never fatal — a hiccup here is recovered by the
// reaper's settlement sweep, not by failing the run.
async function settleAllowance(
  optRunId: string,
  outcome: "completed" | "failed",
): Promise<void> {
  const { error } = await supabase.rpc("settle_optimization_run", {
    p_run_id: optRunId,
  });
  if (error) {
    log.error("Allowance settlement failed", {
      event: "optimization_run.settle_failed",
      opt_run_id: optRunId,
      error,
    });
  }
  // Settle the Eval Point reservation to the rollouts actually scored (ADR-0016).
  const { error: ptErr } = await supabase.rpc(
    "settle_optimization_run_points",
    {
      p_run_id: optRunId,
      p_outcome: outcome,
    },
  );
  if (ptErr) {
    log.error("Optimization point settlement failed", {
      event: "optimization_run.points_settle_failed",
      opt_run_id: optRunId,
      error: ptErr,
    });
  }
  // Release the run's managed-spend reservation (#185) so committed spend
  // converges to accrued actuals. Idempotent; a no-op for BYO runs. Never fatal.
  const { error: relErr } = await supabase.rpc("release_managed_reservation", {
    p_eval_run_id: null,
    p_opt_run_id: optRunId,
  });
  if (relErr) {
    log.error("Managed reservation release failed", {
      event: "managed_spend.release_failed",
      opt_run_id: optRunId,
      error: relErr,
    });
  }
}

export async function completeRun(input: CompleteRunInput): Promise<void> {
  const { data, error } = await supabase
    .from("optimization_runs")
    .update({
      status: "completed",
      best_candidate_id: input.bestCandidateId,
      best_score: input.overallScore,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.optRunId)
    .select("created_at, org_id")
    .maybeSingle();
  if (error)
    throw new Error(`Failed to complete optimization run: ${error.message}`);

  // Patch org_id into the ambient Activity log scope (this Activity never calls loadRun, so the
  // interceptor has stamped only opt_run_id) — keeps the terminal event and every downstream log
  // here (settlement, email-failure) tenant-filterable, mirroring loadRun.
  if (data?.org_id) setLogContext({ org_id: data.org_id });

  // Structured terminal event, parallel to `eval_run.completed` in worker.ts: optimization runs
  // had no queryable completed/failed log of their own (only email-failure errors), so a run's
  // outcome, lift, and lifetime weren't filterable in PostHog Logs. opt_run_id is already
  // auto-stamped by the Activity log-context interceptor; it's passed explicitly here for parity.
  log.info("Optimization run completed", {
    event: "optimization_run.completed",
    opt_run_id: input.optRunId,
    best_candidate_id: input.bestCandidateId,
    best_score: input.overallScore,
    seed_score: input.seedScore,
    rollouts_used: input.rolloutsUsed,
    duration_ms: durationMsSince(data?.created_at),
  });

  await settleAllowance(input.optRunId, "completed");

  // Best-effort: notify the starter. A failed email must never fail the terminal transition
  // (it would surface as a retryable Activity error and loop), so wrap and swallow.
  try {
    const notify = await loadRunNotification(input.optRunId);
    await sendOptimizationCompletionEmail(notify.email, {
      runId: input.optRunId,
      connectionName: notify.connectionName,
      seedScore: input.seedScore,
      bestScore: input.overallScore,
      rolloutsUsed: input.rolloutsUsed,
      instanceCount: notify.instanceCount,
      appUrl: APP_URL,
    });
  } catch (err) {
    log.error("Failed to send optimization completion email", {
      event: "optimization_run.completion_email_failed",
      opt_run_id: input.optRunId,
      error: err,
    });
  }
}

export async function failRun(input: {
  optRunId: string;
  message: string;
}): Promise<void> {
  // paused_reason is cleared: a run that fails out of a pause (max-wait cap) is no longer
  // waiting — error_message is the authoritative reason from here on.
  const { data, error } = await supabase
    .from("optimization_runs")
    .update({
      status: "failed",
      error_message: input.message,
      paused_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.optRunId)
    .select("created_at, org_id")
    .maybeSingle();
  // Throw so Temporal retries the Activity — otherwise the run stays 'running',
  // holding the org's single active slot forever (completeRun does the same).
  if (error)
    throw new Error(`Failed to mark optimization run failed: ${error.message}`);

  // See completeRun: patch org_id into the ambient scope so the terminal event and the
  // email-failure log below stay tenant-filterable (this Activity never calls loadRun).
  if (data?.org_id) setLogContext({ org_id: data.org_id });

  // Structured terminal event, parallel to `eval_run.failed` in worker.ts (see completeRun).
  log.error("Optimization run failed", {
    event: "optimization_run.failed",
    opt_run_id: input.optRunId,
    error_message: input.message,
    duration_ms: durationMsSince(data?.created_at),
  });

  await settleAllowance(input.optRunId, "failed");

  // Best-effort, same contract as completeRun: a send failure is logged, never thrown.
  try {
    const notify = await loadRunNotification(input.optRunId);
    await sendOptimizationFailureEmail(notify.email, {
      runId: input.optRunId,
      connectionName: notify.connectionName,
      errorMessage: input.message,
      appUrl: APP_URL,
    });
  } catch (err) {
    log.error("Failed to send optimization failure email", {
      event: "optimization_run.failure_email_failed",
      opt_run_id: input.optRunId,
      error: err,
    });
  }
}

// ---- pause-and-wait on endpoint outage (#102) ----

// Flip the run to 'paused' with a human-readable reason getOptimizationRun() surfaces. The
// run keeps holding the org's one-active-run slot (the partial unique index covers 'paused')
// and is exempt from the stale-run reaper (scoped to 'running') — the workflow's max-wait
// cap is the backstop instead.
export async function pauseRun(input: {
  optRunId: string;
  reason: string;
}): Promise<void> {
  // Compare-and-set on 'running', mirroring cancelOptimizationRun's CAS. terminate() doesn't
  // stop an in-flight activity attempt, so a cancel can land its 'failed' write while this
  // activity executes — an unguarded update would then flip the terminated run back to
  // 'paused', holding the org's active slot forever (paused rows are exempt from the
  // stale-run reaper). The guard also keeps retried attempts idempotent: a repeat finds the
  // row already 'paused' and no-ops.
  const { data, error } = await supabase
    .from("optimization_runs")
    .update({
      status: "paused",
      paused_reason: input.reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.optRunId)
    .eq("status", "running")
    .select("id");
  if (error)
    throw new Error(`Failed to pause optimization run: ${error.message}`);
  // No row transitioned: the run already left 'running' (cancelled mid-pause, or a retried
  // attempt that paused it earlier). Nothing changed, so nothing to announce — skip the email.
  if (!data || data.length === 0) return;

  // Best-effort, same contract as completeRun/failRun: tell the starter the run is paused
  // (auto-retrying with backoff, "Retry now" override, deep link). A send failure is logged,
  // never thrown — the pause transition must not fail on email trouble.
  try {
    const notify = await loadRunNotification(input.optRunId);
    await sendOptimizationPausedEmail(notify.email, {
      runId: input.optRunId,
      connectionName: notify.connectionName,
      reason: input.reason,
      appUrl: APP_URL,
    });
  } catch (err) {
    log.error("Failed to send optimization paused email", {
      opt_run_id: input.optRunId,
      error: err,
    });
  }
}

// Flip a paused run back to 'running' and clear the pause reason. Also stamps updated_at so
// the stale-run reaper's clock starts fresh the moment the run is live again. Guarded on
// 'paused' for the same reason as pauseRun's CAS: a cancel landing while this activity is
// in flight must not be clobbered back to 'running' (and retried attempts stay no-ops).
export async function resumeRun(input: { optRunId: string }): Promise<void> {
  const { error } = await supabase
    .from("optimization_runs")
    .update({
      status: "running",
      paused_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.optRunId)
    .eq("status", "paused");
  if (error)
    throw new Error(`Failed to resume optimization run: ${error.message}`);
}

export interface ProbeEndpointResult {
  healthy: boolean;
  // The endpoint failure message when unhealthy, for the workflow's pause logging.
  message?: string;
}

// Cap on the probe's own HTTP round-trip, comfortably below the Activity's 2-minute
// startToCloseTimeout: a hanging endpoint (a classic outage mode — undici's default header
// timeout is 300s) becomes an AgentEndpointError VERDICT here rather than an Activity
// timeout failure the workflow has to treat as "still down" without a message.
const PROBE_FETCH_TIMEOUT_MS = 60 * 1000;

// Health-probe the run's agent endpoint with a single cheap call while the run is paused.
// Returns a verdict instead of throwing: a failed probe is the expected answer during an
// outage, not an Activity error to retry. Only an AgentEndpointError counts as unhealthy —
// a 2xx whose body doesn't parse to the response_path means the endpoint is back up (the
// real rollout's own error handling deals with contract problems).
export async function probeEndpoint(input: {
  optRunId: string;
}): Promise<ProbeEndpointResult> {
  const run = await loadRun(input.optRunId);
  const connection = await loadConnection(run.connection_id);
  const authValue = await getAuthValue(connection.auth_secret_id);
  try {
    await invokeAgent(
      connection,
      {
        row_index: -1,
        user_input: "Health check: please reply with a short acknowledgement.",
        expected_output: null,
        retrieval_context: null,
      },
      authValue,
      null,
      AbortSignal.timeout(PROBE_FETCH_TIMEOUT_MS),
    );
  } catch (err) {
    if (err instanceof AgentEndpointError)
      return { healthy: false, message: err.message };
    // Non-endpoint errors (timeout, network failure, etc.) are re-thrown so the workflow's
    // outer catch can treat the probe as "still down" rather than incorrectly as healthy.
    throw err;
  }
  return { healthy: true };
}

export interface RunNotificationContext {
  // The starter's email (created_by -> auth.users), or null if it can't be resolved — the
  // emailer treats a null recipient as a no-op rather than failing the transition.
  email: string | null;
  connectionName: string;
  instanceCount: number;
}

// Resolve everything the terminal-state emails need that isn't carried from the workflow: the
// starter's email, the agent Connection's name, and the frozen instance count. The recipient is
// the run's created_by user (v1 has no recipients field).
export async function loadRunNotification(
  optRunId: string,
): Promise<RunNotificationContext> {
  const { data: run, error } = await supabase
    .from("optimization_runs")
    .select("created_by, connections!inner(name)")
    .eq("id", optRunId)
    .maybeSingle<{
      created_by: string;
      connections: { name: string } | { name: string }[];
    }>();
  if (error)
    throw new Error(`Failed to load run for notification: ${error.message}`);
  if (!run) throw new Error("Optimization run not found");

  const connection = Array.isArray(run.connections)
    ? run.connections[0]
    : run.connections;

  const { count, error: countErr } = await supabase
    .from("optimization_inputs")
    .select("id", { count: "exact", head: true })
    .eq("opt_run_id", optRunId);
  if (countErr)
    throw new Error(
      `Failed to count optimization instances: ${countErr.message}`,
    );

  return {
    email: await resolveUserEmail(run.created_by),
    connectionName: connection?.name ?? "your agent",
    instanceCount: count ?? 0,
  };
}

// The starter's email lives in auth.users (public.users has no email column), so resolve it via
// the service-role admin auth API — the same path the team-members reader uses. A transport
// failure or missing user yields null, which the emailer treats as "no recipient".
async function resolveUserEmail(userId: string): Promise<string | null> {
  const { data } = await supabase.auth.admin
    .getUserById(userId)
    .catch(() => ({ data: { user: null } }));
  return data.user?.email ?? null;
}

// ---- loaders ----

interface OptimizationRunRow {
  id: string;
  org_id: string;
  connection_id: string;
  rubric_id: string;
  eval_type: string;
  reflect_model: string;
  budget_rollouts: number;
  max_iters: number;
  plateau_patience: number | null;
  pause_max_wait_minutes: number;
  probe_interval_seconds: number;
}

async function loadRun(optRunId: string): Promise<OptimizationRunRow> {
  const { data, error } = await supabase
    .from("optimization_runs")
    .select(
      "id, org_id, connection_id, rubric_id, eval_type, reflect_model, budget_rollouts, max_iters, plateau_patience, pause_max_wait_minutes, probe_interval_seconds",
    )
    .eq("id", optRunId)
    .maybeSingle<OptimizationRunRow>();
  if (error)
    throw new Error(`Failed to load optimization run: ${error.message}`);
  if (!data) throw new Error("Optimization run not found");
  // Patch org_id into the ambient log scope (opened per Activity by the Temporal interceptor):
  // it isn't in the Activity args, so this is where deep-call-site logs pick it up. No-op outside
  // a scope, so non-Activity callers (tests) are unaffected.
  setLogContext({ org_id: data.org_id });
  return data;
}

// Resolve the Team's LLM key for an optimization activity (#184): BYO key, or the
// managed platform key for paid Teams. The provider is derived from the model the
// activity will call (judge model for rollouts, reflect model for proposals), not
// hardcoded. Optimization is paid-only, so "none" is effectively unreachable — but
// if it happens, fail terminally (a non-retryable ApplicationFailure, per the
// Temporal contract) rather than retry a keyless run forever.
async function resolveOptimizationKey(
  orgId: string,
  model: string,
): Promise<{ key: string; source: "byo" | "managed" }> {
  const resolved = await resolveProviderKey(
    supabase,
    orgId,
    providerForModel(model),
  );
  if (resolved.source === "none") {
    throw ApplicationFailure.create({
      type: PROVIDER_KEY_MISSING_TYPE,
      message: MISSING_PROVIDER_KEY_MESSAGE,
      nonRetryable: true,
    });
  }
  return { key: resolved.key, source: resolved.source };
}

// Build the managed meter for an optimization activity (#185) when the run is on
// a managed key (paid Team, no BYO key); null for BYO (never metered). Pre-flights
// the model against the price table so an unpriced managed model fails closed.
async function optimizationMeter(
  orgId: string,
  optRunId: string,
  source: "byo" | "managed",
  model: string,
): Promise<ManagedMeter | null> {
  if (source !== "managed") return null;
  const meter = await createManagedMeter(supabase, orgId, { optRunId });
  meter?.assertPriced(providerForModel(model), model);
  return meter;
}

// A managed cap-reached / unpriced-model failure must terminate the run, never
// retry forever (the Temporal gotcha: a plain Error retries the Activity). Convert
// them to a non-retryable ApplicationFailure so the workflow lands in failRun.
// Attribute a failed optimization provider call to the customer's own (BYO) key when that is the
// key in play, mirroring the eval worker's run error path (providers/provider-error.ts). The GEPA
// activities each make a single-provider call (judge, reflect/generation, or a Managed Agent's
// target), so the provider + key source are known at the catch site — no per-provider map needed.
// A managed-key failure deliberately does NOT emit this (it stays the generic provider error), and
// a non-provider error (DB/logic) is ignored. NEVER logs key material — provider, org, opt-run id,
// and the provider's HTTP status/error only. Best-effort: logging must never mask the real failure.
function logByoOptimizationKeyFailure(
  err: unknown,
  ctx: {
    source: "byo" | "managed";
    provider: LlmProvider;
    orgId: string;
    optRunId: string;
  },
): void {
  if (ctx.source !== "byo") return;
  const failure = classifyProviderError(err);
  if (!failure) return;
  log.warn("Customer BYO provider key was rejected by the provider", {
    event: "provider_key.byo_failed",
    provider: ctx.provider,
    org_id: ctx.orgId,
    opt_run_id: ctx.optRunId,
    status: failure.status,
    error: err instanceof Error ? err.message : String(err),
  });
}

function rethrowManagedAsTerminal(err: unknown): never {
  if (
    err instanceof ManagedSpendCapExceeded ||
    err instanceof UnpricedManagedCallError ||
    err instanceof ManagedPaymentBlockedError
  ) {
    throw ApplicationFailure.create({
      type: MANAGED_SPEND_BLOCKED_TYPE,
      message: err.message,
      nonRetryable: true,
    });
  }
  throw err;
}

async function loadConnection(connectionId: string): Promise<AgentConnection> {
  const { data, error } = await supabase
    .from("connections")
    .select(CONNECTION_COLUMNS)
    .eq("id", connectionId)
    .maybeSingle<AgentConnection>();
  if (error) throw new Error(`Failed to load connection: ${error.message}`);
  if (!data) throw new Error("Connection not found");
  if (data.kind !== "agent")
    throw new Error("Optimization requires an agent Connection");
  return data;
}

async function loadRubric(rubricId: string): Promise<Rubric> {
  const { data, error } = await supabase
    .from("rubrics")
    .select(
      "name, scenario_description, expected_outcome, grounding_context, criteria",
    )
    .eq("id", rubricId)
    .maybeSingle<Rubric>();
  if (error) throw new Error(`Failed to load rubric: ${error.message}`);
  if (!data) throw new Error("Rubric not found");
  return data;
}

async function loadCandidatePrompts(
  candidateId: string,
): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from("optimization_candidates")
    .select("prompts")
    .eq("id", candidateId)
    .maybeSingle<{ prompts: Record<string, string> | null }>();
  if (error) throw new Error(`Failed to load candidate: ${error.message}`);
  if (!data) throw new Error("Candidate not found");
  return data.prompts ?? {};
}

interface CandidateRow {
  prompts: Record<string, string> | null;
  generation: number;
}

async function loadCandidate(
  candidateId: string,
): Promise<{ prompts: Record<string, string>; generation: number }> {
  const { data, error } = await supabase
    .from("optimization_candidates")
    .select("prompts, generation")
    .eq("id", candidateId)
    .maybeSingle<CandidateRow>();
  if (error) throw new Error(`Failed to load candidate: ${error.message}`);
  if (!data) throw new Error("Candidate not found");
  return { prompts: data.prompts ?? {}, generation: data.generation };
}

interface MinibatchRolloutRow {
  id: string;
  instance_index: number;
  agent_output: string | null;
}
interface RolloutResultRow {
  rollout_id: string;
  criterion_name: string;
  score: number;
  reasoning: string;
}

// Gather the parent Candidate's minibatch rollouts as reflection examples: each instance's
// input + agent output + the judge's per-criterion score/reasoning. This is the textual
// feedback GEPA reflects on.
async function loadMinibatchFeedback(
  optRunId: string,
  candidateId: string,
): Promise<ReflectionExample[]> {
  const { data: rollouts, error: rErr } = await supabase
    .from("optimization_rollouts")
    .select("id, instance_index, agent_output")
    .eq("candidate_id", candidateId)
    .eq("phase", MINIBATCH)
    .order("instance_index", { ascending: true })
    .returns<MinibatchRolloutRow[]>();
  if (rErr)
    throw new Error(`Failed to load minibatch rollouts: ${rErr.message}`);
  if (!rollouts?.length) return [];

  const rolloutIds = rollouts.map((r) => r.id);
  const instanceIndices = rollouts.map((r) => r.instance_index);

  const { data: results, error: resErr } = await supabase
    .from("rollout_results")
    .select("rollout_id, criterion_name, score, reasoning")
    .in("rollout_id", rolloutIds)
    .returns<RolloutResultRow[]>();
  if (resErr)
    throw new Error(`Failed to load rollout results: ${resErr.message}`);

  const { data: inputs, error: inErr } = await supabase
    .from("optimization_inputs")
    .select("instance_index, user_input")
    .eq("opt_run_id", optRunId)
    .in("instance_index", instanceIndices)
    .returns<{ instance_index: number; user_input: string }[]>();
  if (inErr) throw new Error(`Failed to load instances: ${inErr.message}`);

  const inputByIndex = new Map(
    (inputs ?? []).map((i) => [i.instance_index, i.user_input]),
  );
  const resultsByRollout = new Map<string, RolloutResultRow[]>();
  for (const r of results ?? []) {
    const list = resultsByRollout.get(r.rollout_id) ?? [];
    list.push(r);
    resultsByRollout.set(r.rollout_id, list);
  }

  return rollouts.map((r) => ({
    userInput: inputByIndex.get(r.instance_index) ?? "",
    agentOutput: r.agent_output ?? "",
    criteria: (resultsByRollout.get(r.id) ?? []).map((x) => ({
      name: x.criterion_name,
      score: x.score,
      reasoning: x.reasoning,
    })),
  }));
}

// Decrypt the Connection's credential (full header value, e.g. "Bearer ..."), if any.
async function getAuthValue(
  authSecretId: string | null,
): Promise<string | null> {
  if (!authSecretId) return null;
  const { data, error } = await supabase.rpc("get_connection_auth", {
    p_secret_id: authSecretId,
  });
  if (error)
    throw new Error(`Failed to read Connection credential: ${error.message}`);
  return (data as string) ?? null;
}
