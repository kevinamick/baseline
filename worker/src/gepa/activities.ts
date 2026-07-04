// GEPA optimization Activities (ADR-0006). All Postgres access for an Optimization Run
// lives here: the Workflow carries only IDs, and these Activities read the real prompts /
// frozen instances and write rollouts / results back. Registered into the Temporal worker
// by re-export from temporal/activities.ts. This is plain Node — no sandbox constraints.

import { createClient } from "@supabase/supabase-js";
import { log } from "../log.js";
import { setLogContext } from "../log-context.js";
import { ApplicationFailure } from "@temporalio/common";
import {
  providerForModel,
  isAnthropicModel,
  defaultJudgeModelForProvider,
} from "../providers/models.js";
import type { ReflectionExample } from "../providers/llm.js";
import {
  classifyMeteredFailure,
  meteredCall,
  resolveKeyForModel,
  resolveMeteredCall,
  type MeteredCallScope,
} from "../providers/metered-call.js";
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
import { settleTerminalRun } from "../settle-terminal-run.js";

// Guarded-transition status lists (#378). A normal completion only ever leaves 'running'. A
// failure can strike before seedRun ever claims the run running ('queued'), mid-loop
// ('running'), or while paused waiting out an endpoint outage and the max-wait cap gives up
// without resuming first ('paused' — workflow.ts's pause-and-wait loop).
const FROM_RUNNING = ["running"] as const;
const FROM_NON_TERMINAL = ["queued", "running", "paused"] as const;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GEPA's circuit breaker (gepa/circuit-breaker.ts) branches the workflow on distinct
// ApplicationFailure `type` markers per failure class — unlike eval-run's single
// "EvalRunTerminal" marker (evalrun/activities.ts) — so this is the GEPA half of
// metered-call.ts's MeteredCallTerminals pair (#384).
const METERED_TERMINALS = {
  missingKey: PROVIDER_KEY_MISSING_TYPE,
  billingBlocked: MANAGED_SPEND_BLOCKED_TYPE,
};

function meteredScope(optRunId: string, orgId: string): MeteredCallScope {
  return { supabase, orgId, run: { optRunId }, terminals: METERED_TERMINALS };
}

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
  // Managed Agent target key resolution + metering (#291), via the shared metered-call ritual
  // (#384): resolve the key, fail closed on an unpriced target model or (defense-in-depth,
  // mirrors the eval path's guard) a managed target with no reservation, and build the
  // host-pinned provider + meter. Resolved once for the whole rollout (every instance shares it),
  // not re-resolved per instance.
  const targetCtx = managed
    ? await resolveMeteredCall({
        scope: meteredScope(optRunId, run.org_id),
        callKind: "agent",
        resolveKey: () => resolveKeyForModel(supabase, run.org_id, connection.target_model!),
      })
    : null;

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
            targetCtx!.provider,
            prompts,
          );
          agentOutput = text;
          // Meter the target-model tokens (a no-op when BYO/unmetered). record() is atomic
          // per-org in the DB, so concurrent rollouts serialize safely and the cap check sees a
          // running total; it throws ManagedSpendCapExceeded the instant the cap is reached.
          await targetCtx!.record(usage);
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
        // still gets the capped retries; a sustained outage trips the breaker upstream — this
        // must run BEFORE the metered classification below, since an endpoint failure isn't a
        // key/billing issue and must keep its own distinct retryable marker.
        if (err instanceof AgentEndpointError) {
          throw ApplicationFailure.create({
            type: AGENT_ENDPOINT_ERROR_TYPE,
            message: err.message,
          });
        }
        // A Managed Agent target call on the Team's own key that the provider rejects is the
        // customer's BYO key failing (classifyMeteredFailure logs it, no-op for managed/none), and
        // a managed cap breach / unpriced model from target-model metering (#291) is terminal —
        // converted so the run stops the instant accrued spend reaches the cap (mid-rollout)
        // instead of retrying the Activity forever. Anything else rethrows unchanged. Only reached
        // for a Managed Agent (targetCtx is set); an external agent's endpoint errors are handled
        // above and anything else just rethrows.
        throw targetCtx
          ? classifyMeteredFailure(err, meteredScope(optRunId, run.org_id), targetCtx)
          : err;
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
  // (Anthropic keeps its ANTHROPIC_MODEL env override). meteredCall resolves + guards + judges +
  // classifies in one call; `requireReservation: false` preserves this call site's existing
  // behavior of NOT enforcing the missing-reservation guard (unlike the eval judge and both
  // Managed-Agent target call sites — see metered-call.ts's module header).
  const judgeModel = defaultJudgeModelForProvider(providerForModel(run.reflect_model));
  const { results, overallScore } = await meteredCall({
    scope: meteredScope(optRunId, run.org_id),
    callKind: "judge",
    resolveKey: () => resolveKeyForModel(supabase, run.org_id, judgeModel),
    providerOpts: (model) => ({ judgeModel: model }),
    requireReservation: false,
    execute: ({ provider, meter }) => evaluateRun(rubric, rows, provider, run.eval_type, meter),
  });

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

  // Reflect + meter via the shared metered-call ritual (#384); requireReservation: false mirrors
  // this call site's existing behavior (see rolloutCandidate's judge call for the same note).
  const newPrompt = await meteredCall({
    scope: meteredScope(optRunId, run.org_id),
    callKind: "reflect",
    resolveKey: () => resolveKeyForModel(supabase, run.org_id, run.reflect_model),
    providerOpts: () => ({ reflectModel: run.reflect_model }),
    requireReservation: false,
    execute: async ({ provider, record }) => {
      const proposed = await provider.propose({
        targetModule,
        currentPrompt: parent.prompts[targetModule] ?? "",
        examples,
      });
      // Meter the reflection call's actual tokens; a cap breach throws here.
      await record(proposed.usage);
      return proposed.prompt;
    },
  });

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

  const operator = selectOperator(operatorSeed);
  const { system, user } = buildRewriteMessages(
    operator,
    parent.prompts[targetModule] ?? "",
  );

  // The generation model is stored in reflect_model (the column that records "the model that
  // proposes the next prompt"); Simple Mode defaults it to Haiku at run creation. It runs on the
  // Team's key and is metered like a reflection call (callKind 'reflect' is the existing bucket
  // for a prompt-proposer call — Simple has no distinct kind), via the shared metered-call ritual
  // (#384); requireReservation: false mirrors this call site's existing behavior (see
  // rolloutCandidate's judge call for the same note).
  const newPrompt = await meteredCall({
    scope: meteredScope(optRunId, run.org_id),
    callKind: "reflect",
    resolveKey: () => resolveKeyForModel(supabase, run.org_id, run.reflect_model),
    requireReservation: false,
    execute: async ({ provider, record }) => {
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
      // Meter the generation call's actual tokens; a cap breach throws here.
      await record(usage);
      const extracted = extractProposedPrompt(text);
      // A model that returns nothing usable shouldn't install an empty prompt; surface it so the
      // workflow logs the failed variant and moves on rather than scoring an empty Candidate.
      if (!extracted) throw new Error("Generation model returned an empty prompt");
      return extracted;
    },
  });

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

// Columns the terminal transition reads back (#378): `created_at` for the terminal log's
// duration_ms clock, `org_id` for the ambient log-context patch (this Activity never calls
// loadRun, so the interceptor has stamped only opt_run_id).
type TerminalRow = { created_at: string | null; org_id?: string };

export async function completeRun(input: CompleteRunInput): Promise<void> {
  await settleTerminalRun<TerminalRow>({
    runKind: "optimization",
    runId: input.optRunId,
    outcome: "completed",
    fromStatuses: FROM_RUNNING,
    patch: { best_candidate_id: input.bestCandidateId, best_score: input.overallScore },
    selectColumns: "created_at, org_id",
    notify: {
      run: async (row) => {
        if (row.org_id) setLogContext({ org_id: row.org_id });

        // Structured terminal event, parallel to `eval_run.completed` in worker.ts:
        // optimization runs had no queryable completed/failed log of their own (only
        // email-failure errors), so a run's outcome, lift, and lifetime weren't filterable in
        // PostHog Logs. opt_run_id is already auto-stamped by the Activity log-context
        // interceptor; it's passed explicitly here for parity.
        log.info("Optimization run completed", {
          event: "optimization_run.completed",
          opt_run_id: input.optRunId,
          best_candidate_id: input.bestCandidateId,
          best_score: input.overallScore,
          seed_score: input.seedScore,
          rollouts_used: input.rolloutsUsed,
          duration_ms: durationMsSince(row.created_at),
        });

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
      },
      onError: (err) => {
        log.error("Failed to send optimization completion email", {
          event: "optimization_run.completion_email_failed",
          opt_run_id: input.optRunId,
          error: err,
        });
      },
    },
  });
}

export async function failRun(input: {
  optRunId: string;
  message: string;
}): Promise<void> {
  await settleTerminalRun<TerminalRow>({
    runKind: "optimization",
    runId: input.optRunId,
    outcome: "failed",
    // A failure can strike before seedRun claims the run running ('queued'), mid-loop
    // ('running'), or paused waiting out an endpoint outage when the max-wait cap gives up
    // without resuming first ('paused').
    fromStatuses: FROM_NON_TERMINAL,
    // paused_reason is cleared: a run that fails out of a pause (max-wait cap) is no longer
    // waiting — error_message is the authoritative reason from here on.
    patch: { error_message: input.message, paused_reason: null },
    selectColumns: "created_at, org_id",
    notify: {
      run: async (row) => {
        // See completeRun: patch org_id into the ambient scope so the terminal event and the
        // email-failure log below stay tenant-filterable (this Activity never calls loadRun).
        if (row.org_id) setLogContext({ org_id: row.org_id });

        // Structured terminal event, parallel to `eval_run.failed` in worker.ts (see completeRun).
        log.error("Optimization run failed", {
          event: "optimization_run.failed",
          opt_run_id: input.optRunId,
          error_message: input.message,
          duration_ms: durationMsSince(row.created_at),
        });

        const notify = await loadRunNotification(input.optRunId);
        await sendOptimizationFailureEmail(notify.email, {
          runId: input.optRunId,
          connectionName: notify.connectionName,
          errorMessage: input.message,
          appUrl: APP_URL,
        });
      },
      onError: (err) => {
        log.error("Failed to send optimization failure email", {
          event: "optimization_run.failure_email_failed",
          opt_run_id: input.optRunId,
          error: err,
        });
      },
    },
  });
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

// Key resolution, managed metering (guard + build), and BYO-attribution + terminal-conversion
// classification for optimization Activities now all live in the shared metered-call ritual
// (providers/metered-call.ts, #384) — meteredScope/METERED_TERMINALS above wire this file's
// distinct ApplicationFailure type markers (PROVIDER_KEY_MISSING_TYPE, MANAGED_SPEND_BLOCKED_TYPE)
// into it. See rolloutCandidate, proposeCandidate, and proposeSimpleCandidate for the call sites.

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
