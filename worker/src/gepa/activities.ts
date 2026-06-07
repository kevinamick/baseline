// GEPA optimization Activities (ADR-0006). All Postgres access for an Optimization Run
// lives here: the Workflow carries only IDs, and these Activities read the real prompts /
// frozen instances and write rollouts / results back. Registered into the Temporal worker
// by re-export from temporal/activities.ts. This is plain Node — no sandbox constraints.

import { createClient } from "@supabase/supabase-js";
import { ApplicationFailure } from "@temporalio/common";
import { AnthropicProvider } from "../providers/anthropic.js";
import type { ReflectionExample } from "../providers/llm.js";
import { evaluateRun, type Rubric } from "../evaluator.js";
import { AgentEndpointError, invokeAgent, type AgentConnection } from "../agent.js";
import { perInstanceScores, seedPromptsFor } from "./scoring.js";
import { MINIBATCH, type RolloutPhase } from "./phase.js";
import { AGENT_ENDPOINT_ERROR_TYPE } from "./circuit-breaker.js";
import {
  sendOptimizationCompletionEmail,
  sendOptimizationFailureEmail,
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
  "id, kind, provider, endpoint, auth_header, auth_secret_id, request_template, response_path, optimizable_prompts";

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
    try {
      agentOutput = await invokeAgent(
        connection,
        {
          row_index: inst.instance_index,
          user_input: inst.user_input,
          expected_output: inst.expected_output,
          retrieval_context: inst.retrieval_context,
        },
        authValue,
        prompts
      );
    } catch (err) {
      // Re-tag a customer-endpoint failure so the cross-Activity boundary carries a stable
      // `type` the workflow's circuit breaker recognizes (#90). Retryable so a transient blip
      // still gets the capped retries; a sustained outage trips the breaker upstream.
      if (err instanceof AgentEndpointError) {
        throw ApplicationFailure.create({ type: AGENT_ENDPOINT_ERROR_TYPE, message: err.message });
      }
      throw err;
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

  const provider = new AnthropicProvider();
  const { results, overallScore } = await evaluateRun(rubric, rows, provider, run.eval_type);

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

  const provider = new AnthropicProvider({ reflectModel: run.reflect_model });
  const newPrompt = await provider.propose({
    targetModule,
    currentPrompt: parent.prompts[targetModule] ?? "",
    examples,
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
    console.error("Failed to send optimization completion email", input.optRunId, err);
  }
}

export async function failRun(input: { optRunId: string; message: string }): Promise<void> {
  await supabase
    .from("optimization_runs")
    .update({ status: "failed", error_message: input.message, updated_at: new Date().toISOString() })
    .eq("id", input.optRunId);

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
    console.error("Failed to send optimization failure email", input.optRunId, err);
  }
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
  connection_id: string;
  rubric_id: string;
  eval_type: string;
  reflect_model: string;
  budget_rollouts: number;
  max_iters: number;
  plateau_patience: number | null;
}

async function loadRun(optRunId: string): Promise<OptimizationRunRow> {
  const { data, error } = await supabase
    .from("optimization_runs")
    .select(
      "id, connection_id, rubric_id, eval_type, reflect_model, budget_rollouts, max_iters, plateau_patience"
    )
    .eq("id", optRunId)
    .maybeSingle<OptimizationRunRow>();
  if (error) throw new Error(`Failed to load optimization run: ${error.message}`);
  if (!data) throw new Error("Optimization run not found");
  return data;
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
