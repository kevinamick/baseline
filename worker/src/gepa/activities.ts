// GEPA optimization Activities (ADR-0006). All Postgres access for an Optimization Run
// lives here: the Workflow carries only IDs, and these Activities read the real prompts /
// frozen instances and write rollouts / results back. Registered into the Temporal worker
// by re-export from temporal/activities.ts. This is plain Node — no sandbox constraints.

import { createClient } from "@supabase/supabase-js";
import { log } from "../log.js";
import { ApplicationFailure } from "@temporalio/common";
import { createProviderForModel } from "../providers/factory.js";
import type { RuntimeProvider } from "../providers/llm.js";
import { resolveProviderKey, MISSING_PROVIDER_KEY_MESSAGE } from "../providers/resolve-key.js";
import {
  providerForModel,
  isAnthropicModel,
  defaultJudgeModelForProvider,
} from "../providers/models.js";
import {
  createManagedMeter,
  ManagedSpendCapExceeded,
  ManagedPaymentBlockedError,
  UnpricedManagedCallError,
  type ManagedMeter,
} from "../providers/managed-meter.js";
import type { ReflectionExample } from "../providers/llm.js";
import { evaluateRun, type Rubric } from "../evaluator.js";
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
import { AGENT_ENDPOINT_ERROR_TYPE, MANAGED_SPEND_BLOCKED_TYPE } from "./circuit-breaker.js";
import {
  sendOptimizationCompletionEmail,
  sendOptimizationFailureEmail,
  sendOptimizationPausedEmail,
} from "../optimization-emailer.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Base URL for the run's deep link in terminal-state emails. Mirrors the eval worker's APP_URL.
const APP_URL = process.env.APP_URL ?? "https://baseline.app";

// In-run rollout parallelism cap (D12): agent invocations within a single rollout fan out up to
// this many at a time. Bounds load on the customer endpoint and respects Anthropic rate limits
// while still being far faster than one-at-a-time over a 50-instance Pareto set.
const ROLLOUT_CONCURRENCY = 5;

// Run `fn` over `items` with at most `limit` in flight, returning results in input order. A
// rejection from any call propagates (the rollout fails fast); a few already-started calls may
// still settle, which is harmless — their results are discarded.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function runner(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runner());
  await Promise.all(runners);
  return results;
}

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

  await supabase
    .from("optimization_runs")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", optRunId);

  const { count } = await supabase
    .from("optimization_inputs")
    .select("id", { count: "exact", head: true })
    .eq("opt_run_id", optRunId);
  const instanceCount = count ?? 0;

  const termination = {
    budgetRollouts: run.budget_rollouts,
    maxIters: run.max_iters,
    plateauPatience: run.plateau_patience,
    pauseMaxWaitMinutes: run.pause_max_wait_minutes,
    probeIntervalSeconds: run.probe_interval_seconds,
  };

  const { data: existing } = await supabase
    .from("optimization_candidates")
    .select("id")
    .eq("opt_run_id", optRunId)
    .eq("generation", 0)
    .maybeSingle();
  if (existing) return { candidateId: existing.id, instanceCount, modules, ...termination };

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
  if (error || !candidate) throw new Error(`Failed to seed candidate: ${error?.message}`);

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
export async function rolloutCandidate(input: RolloutInput): Promise<RolloutResult> {
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
  if (managed && (!connection.target_model || !isAnthropicModel(connection.target_model))) {
    // Terminal, not retryable: an unknown/missing target_model would otherwise resolve a key
    // and POST it to the provider with an invalid model, hard-erroring once per instance and
    // retrying the Activity to its cap on a config typo. The wizard (#293) validates the model
    // on save; this is the worker's fail-closed backstop. (providerForModel returns 'anthropic'
    // for anything, so the key/host pin can't catch a bad model — only this can.)
    throw ApplicationFailure.create({
      type: "MANAGED_AGENT_CONFIG",
      message: `Managed Agent has an invalid or missing target_model: ${connection.target_model ?? "(none)"}`,
      nonRetryable: true,
    });
  }
  let managedCompleter: RuntimeProvider | null = null;
  let agentMeter: ManagedMeter | null = null;
  if (managed) {
    const targetKey = await resolveOptimizationKey(run.org_id, connection.target_model!);
    // The factory picks the client for the target model's provider; the target key was resolved
    // for that same provider (resolveOptimizationKey derives it via providerForModel), so a
    // non-Anthropic managed target would use its own provider's key (#204).
    managedCompleter = createProviderForModel(connection.target_model!, { apiKey: targetKey.key });
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
        connection.target_model!
      );
    } catch (err) {
      rethrowManagedAsTerminal(err);
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
  if (!instances?.length) throw new Error("No frozen instances for optimization run");

  // Invoke + persist each instance, fanning out up to ROLLOUT_CONCURRENCY at a time. Results
  // come back in instance order so the evaluator scores a stable row order (parent and child
  // see the same minibatch).
  const settled = await mapWithConcurrency(instances, ROLLOUT_CONCURRENCY, async (inst) => {
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
          prompts
        );
        agentOutput = text;
        // Meter the target-model tokens (null meter = BYO/unmetered). record() is atomic
        // per-org in the DB, so concurrent rollouts serialize safely and the cap check sees a
        // running total; it throws ManagedSpendCapExceeded the instant the cap is reached.
        if (agentMeter) await agentMeter.record({ usage, callKind: "agent" });
      } else {
        agentOutput = await invokeAgent(connection, invokableRow, authValue, prompts);
      }
    } catch (err) {
      // Re-tag a customer-endpoint failure so the cross-Activity boundary carries a stable
      // `type` the workflow's circuit breaker recognizes (#90). Retryable so a transient blip
      // still gets the capped retries; a sustained outage trips the breaker upstream.
      if (err instanceof AgentEndpointError) {
        throw ApplicationFailure.create({ type: AGENT_ENDPOINT_ERROR_TYPE, message: err.message });
      }
      // A managed cap breach / unpriced model from target-model metering (#291) is terminal —
      // convert it to a non-retryable failure so the run stops the instant accrued spend reaches
      // the cap (mid-rollout) instead of retrying the Activity forever. Anything else rethrows.
      rethrowManagedAsTerminal(err);
    }

    const { data: rollout, error: rErr } = await supabase
      .from("optimization_rollouts")
      .upsert(
        { candidate_id: candidateId, instance_index: inst.instance_index, phase, agent_output: agentOutput },
        { onConflict: "candidate_id,instance_index,phase" }
      )
      .select("id")
      .single();
    if (rErr || !rollout) throw new Error(`Failed to persist rollout: ${rErr?.message}`);

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
  });

  const rows: Parameters<typeof evaluateRun>[1] = settled.map((s) => s.row);
  const rolloutIdByInstance: Record<number, string> = {};
  for (const s of settled) rolloutIdByInstance[s.row.row_index] = s.rolloutId;

  // A run is single-provider: the judge runs on the same provider as the run's reflect model
  // (#204), using that provider's default judge model and the Team's key for that provider. So a
  // run with an OpenAI/Google reflect model judges on OpenAI/Google too, driven by the same key
  // (Anthropic keeps its ANTHROPIC_MODEL env override). The factory picks the client by model.
  const judgeModel = defaultJudgeModelForProvider(providerForModel(run.reflect_model));
  const resolved = await resolveOptimizationKey(run.org_id, judgeModel);
  const provider = createProviderForModel(judgeModel, { apiKey: resolved.key, judgeModel });
  const meter = await optimizationMeter(run.org_id, optRunId, resolved.source, judgeModel);
  let results: Awaited<ReturnType<typeof evaluateRun>>["results"];
  let overallScore: number;
  try {
    ({ results, overallScore } = await evaluateRun(
      rubric,
      rows,
      provider,
      run.eval_type,
      meter ?? undefined
    ));
  } catch (err) {
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
    { onConflict: "rollout_id,criterion_name" }
  );
  if (resErr) throw new Error(`Failed to persist rollout results: ${resErr.message}`);

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
  input: ProposeCandidateInput
): Promise<ProposeCandidateResult> {
  const { optRunId, parentCandidateId, targetModule, iteration } = input;
  await touchOptimizationRun(optRunId); // heartbeat for the stale-run reaper

  const { data: existing } = await supabase
    .from("optimization_candidates")
    .select("id")
    .eq("opt_run_id", optRunId)
    .eq("iteration", iteration)
    .maybeSingle();
  if (existing) return { childCandidateId: existing.id };

  const run = await loadRun(optRunId);
  const parent = await loadCandidate(parentCandidateId);
  const examples = await loadMinibatchFeedback(optRunId, parentCandidateId);

  const resolved = await resolveOptimizationKey(run.org_id, run.reflect_model);
  const provider = createProviderForModel(run.reflect_model, {
    apiKey: resolved.key,
    reflectModel: run.reflect_model,
  });
  const meter = await optimizationMeter(
    run.org_id,
    optRunId,
    resolved.source,
    run.reflect_model
  );
  let newPrompt: string;
  try {
    const proposed = await provider.propose({
      targetModule,
      currentPrompt: parent.prompts[targetModule] ?? "",
      examples,
    });
    // Meter the reflection call's actual tokens; a cap breach throws here.
    if (meter) await meter.record({ usage: proposed.usage, callKind: "reflect" });
    newPrompt = proposed.prompt;
  } catch (err) {
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
  input: ProposeSimpleCandidateInput
): Promise<ProposeCandidateResult> {
  const { optRunId, parentCandidateId, targetModule, round, iteration, operatorSeed } = input;
  await touchOptimizationRun(optRunId); // heartbeat for the stale-run reaper

  const { data: existing } = await supabase
    .from("optimization_candidates")
    .select("id")
    .eq("opt_run_id", optRunId)
    .eq("iteration", iteration)
    .maybeSingle();
  if (existing) return { childCandidateId: existing.id };

  const run = await loadRun(optRunId);
  const parent = await loadCandidate(parentCandidateId);

  // The generation model is stored in reflect_model (the column that records "the model that
  // proposes the next prompt"); Simple Mode defaults it to Haiku at run creation. It runs on the
  // Team's key and is metered like a reflection call.
  const resolved = await resolveOptimizationKey(run.org_id, run.reflect_model);
  const provider = createProviderForModel(run.reflect_model, { apiKey: resolved.key });
  const meter = await optimizationMeter(run.org_id, optRunId, resolved.source, run.reflect_model);

  const operator = selectOperator(operatorSeed);
  const { system, user } = buildRewriteMessages(operator, parent.prompts[targetModule] ?? "");

  let newPrompt: string;
  try {
    const { text, usage } = await provider.complete({
      model: run.reflect_model,
      system,
      user,
      maxTokens: 2048,
    });
    // Meter the generation call's actual tokens; a cap breach throws here. callKind 'reflect'
    // is the existing bucket for a prompt-proposer call (Simple has no distinct kind).
    if (meter) await meter.record({ usage, callKind: "reflect" });
    const extracted = extractProposedPrompt(text);
    // A model that returns nothing usable shouldn't install an empty prompt; surface it so the
    // workflow logs the failed variant and moves on rather than scoring an empty Candidate.
    if (!extracted) throw new Error("Generation model returned an empty prompt");
    newPrompt = extracted;
  } catch (err) {
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
    throw new Error(`Failed to persist simple child candidate: ${error?.message}`);
  }

  return { childCandidateId: child.id };
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

// Settle the run's allowance unit (#181). Idempotent in Postgres, derived
// outcome (any executed Rollout = consumed), and never fatal — a hiccup here
// is recovered by the reaper's settlement sweep, not by failing the run.
async function settleAllowance(optRunId: string): Promise<void> {
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
  const { error } = await supabase
    .from("optimization_runs")
    .update({
      status: "completed",
      best_candidate_id: input.bestCandidateId,
      best_score: input.overallScore,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.optRunId);
  if (error) throw new Error(`Failed to complete optimization run: ${error.message}`);

  await settleAllowance(input.optRunId);

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

export async function failRun(input: { optRunId: string; message: string }): Promise<void> {
  // paused_reason is cleared: a run that fails out of a pause (max-wait cap) is no longer
  // waiting — error_message is the authoritative reason from here on.
  const { error } = await supabase
    .from("optimization_runs")
    .update({
      status: "failed",
      error_message: input.message,
      paused_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.optRunId);
  // Throw so Temporal retries the Activity — otherwise the run stays 'running',
  // holding the org's single active slot forever (completeRun does the same).
  if (error) throw new Error(`Failed to mark optimization run failed: ${error.message}`);

  await settleAllowance(input.optRunId);

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
export async function pauseRun(input: { optRunId: string; reason: string }): Promise<void> {
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
  if (error) throw new Error(`Failed to pause optimization run: ${error.message}`);
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
    console.error("Failed to send optimization paused email", input.optRunId, err);
  }
}

// Flip a paused run back to 'running' and clear the pause reason. Also stamps updated_at so
// the stale-run reaper's clock starts fresh the moment the run is live again. Guarded on
// 'paused' for the same reason as pauseRun's CAS: a cancel landing while this activity is
// in flight must not be clobbered back to 'running' (and retried attempts stay no-ops).
export async function resumeRun(input: { optRunId: string }): Promise<void> {
  const { error } = await supabase
    .from("optimization_runs")
    .update({ status: "running", paused_reason: null, updated_at: new Date().toISOString() })
    .eq("id", input.optRunId)
    .eq("status", "paused");
  if (error) throw new Error(`Failed to resume optimization run: ${error.message}`);
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
export async function probeEndpoint(input: { optRunId: string }): Promise<ProbeEndpointResult> {
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
      AbortSignal.timeout(PROBE_FETCH_TIMEOUT_MS)
    );
  } catch (err) {
    if (err instanceof AgentEndpointError) return { healthy: false, message: err.message };
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
export async function loadRunNotification(optRunId: string): Promise<RunNotificationContext> {
  const { data: run, error } = await supabase
    .from("optimization_runs")
    .select("created_by, connections!inner(name)")
    .eq("id", optRunId)
    .maybeSingle<{ created_by: string; connections: { name: string } | { name: string }[] }>();
  if (error) throw new Error(`Failed to load run for notification: ${error.message}`);
  if (!run) throw new Error("Optimization run not found");

  const connection = Array.isArray(run.connections) ? run.connections[0] : run.connections;

  const { count } = await supabase
    .from("optimization_inputs")
    .select("id", { count: "exact", head: true })
    .eq("opt_run_id", optRunId);

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
      "id, org_id, connection_id, rubric_id, eval_type, reflect_model, budget_rollouts, max_iters, plateau_patience, pause_max_wait_minutes, probe_interval_seconds"
    )
    .eq("id", optRunId)
    .maybeSingle<OptimizationRunRow>();
  if (error) throw new Error(`Failed to load optimization run: ${error.message}`);
  if (!data) throw new Error("Optimization run not found");
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
  model: string
): Promise<{ key: string; source: "byo" | "managed" }> {
  const resolved = await resolveProviderKey(supabase, orgId, providerForModel(model));
  if (resolved.source === "none") {
    throw ApplicationFailure.create({
      type: "PROVIDER_KEY_MISSING",
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
  model: string
): Promise<ManagedMeter | null> {
  if (source !== "managed") return null;
  const meter = await createManagedMeter(supabase, orgId, { optRunId });
  meter?.assertPriced(providerForModel(model), model);
  return meter;
}

// A managed cap-reached / unpriced-model failure must terminate the run, never
// retry forever (the Temporal gotcha: a plain Error retries the Activity). Convert
// them to a non-retryable ApplicationFailure so the workflow lands in failRun.
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
  if (data.kind !== "agent") throw new Error("Optimization requires an agent Connection");
  return data;
}

async function loadRubric(rubricId: string): Promise<Rubric> {
  const { data, error } = await supabase
    .from("rubrics")
    .select("name, scenario_description, expected_outcome, grounding_context, criteria")
    .eq("id", rubricId)
    .maybeSingle<Rubric>();
  if (error) throw new Error(`Failed to load rubric: ${error.message}`);
  if (!data) throw new Error("Rubric not found");
  return data;
}

async function loadCandidatePrompts(candidateId: string): Promise<Record<string, string>> {
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
  candidateId: string
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
  candidateId: string
): Promise<ReflectionExample[]> {
  const { data: rollouts, error: rErr } = await supabase
    .from("optimization_rollouts")
    .select("id, instance_index, agent_output")
    .eq("candidate_id", candidateId)
    .eq("phase", MINIBATCH)
    .order("instance_index", { ascending: true })
    .returns<MinibatchRolloutRow[]>();
  if (rErr) throw new Error(`Failed to load minibatch rollouts: ${rErr.message}`);
  if (!rollouts?.length) return [];

  const rolloutIds = rollouts.map((r) => r.id);
  const instanceIndices = rollouts.map((r) => r.instance_index);

  const { data: results, error: resErr } = await supabase
    .from("rollout_results")
    .select("rollout_id, criterion_name, score, reasoning")
    .in("rollout_id", rolloutIds)
    .returns<RolloutResultRow[]>();
  if (resErr) throw new Error(`Failed to load rollout results: ${resErr.message}`);

  const { data: inputs, error: inErr } = await supabase
    .from("optimization_inputs")
    .select("instance_index, user_input")
    .eq("opt_run_id", optRunId)
    .in("instance_index", instanceIndices)
    .returns<{ instance_index: number; user_input: string }[]>();
  if (inErr) throw new Error(`Failed to load instances: ${inErr.message}`);

  const inputByIndex = new Map((inputs ?? []).map((i) => [i.instance_index, i.user_input]));
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
async function getAuthValue(authSecretId: string | null): Promise<string | null> {
  if (!authSecretId) return null;
  const { data, error } = await supabase.rpc("get_connection_auth", { p_secret_id: authSecretId });
  if (error) throw new Error(`Failed to read Connection credential: ${error.message}`);
  return (data as string) ?? null;
}
