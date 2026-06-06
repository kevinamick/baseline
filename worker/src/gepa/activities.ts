// GEPA optimization Activities (ADR-0006). All Postgres access for an Optimization Run
// lives here: the Workflow carries only IDs, and these Activities read the real prompts /
// frozen instances and write rollouts / results back. Registered into the Temporal worker
// by re-export from temporal/activities.ts. This is plain Node — no sandbox constraints.

import { createClient } from "@supabase/supabase-js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { evaluateRun, type Rubric } from "../evaluator.js";
import { invokeAgent, type AgentConnection } from "../agent.js";
import { perInstanceScores, seedPromptsFor } from "./scoring.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Same column set the eval worker loads, plus optimizable_prompts so the agent invoker can
// resolve {{prompt:<module>}} from a Candidate's map (or each Module's seed).
const CONNECTION_COLUMNS =
  "id, kind, provider, endpoint, auth_header, auth_secret_id, request_template, response_path, optimizable_prompts";

// ---- Activities ----

export interface SeedRunResult {
  candidateId: string;
  instanceCount: number;
}

// Seed Candidate 0 from the Connection's Module seeds and mark the run running. Idempotent:
// a retried Activity returns the existing generation-0 Candidate rather than inserting a
// duplicate (the partial work of an earlier attempt is reused, not redone).
export async function seedRun(optRunId: string): Promise<SeedRunResult> {
  const run = await loadRun(optRunId);
  const connection = await loadConnection(run.connection_id);

  await supabase
    .from("optimization_runs")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", optRunId);

  const { count } = await supabase
    .from("optimization_inputs")
    .select("id", { count: "exact", head: true })
    .eq("opt_run_id", optRunId);
  const instanceCount = count ?? 0;

  const { data: existing } = await supabase
    .from("optimization_candidates")
    .select("id")
    .eq("opt_run_id", optRunId)
    .eq("generation", 0)
    .maybeSingle();
  if (existing) return { candidateId: existing.id, instanceCount };

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

  return { candidateId: candidate.id, instanceCount };
}

export interface RolloutInput {
  optRunId: string;
  candidateId: string;
  phase: "minibatch" | "pareto";
}

export interface RolloutResult {
  overallScore: number;
  instanceScores: Record<number, number>;
}

// Run one Candidate across the frozen instance set: invoke the agent per instance with the
// Candidate's prompts, persist each rollout + per-criterion judge result, and return the
// overall + per-instance score vector. Upserts make this safe to retry.
export async function rolloutCandidate(input: RolloutInput): Promise<RolloutResult> {
  const { optRunId, candidateId, phase } = input;
  const run = await loadRun(optRunId);
  const connection = await loadConnection(run.connection_id);
  const rubric = await loadRubric(run.rubric_id);
  const authValue = await getAuthValue(connection.auth_secret_id);
  const prompts = await loadCandidatePrompts(candidateId);

  const { data: instances, error: instErr } = await supabase
    .from("optimization_inputs")
    .select("instance_index, user_input, expected_output, retrieval_context")
    .eq("opt_run_id", optRunId)
    .order("instance_index", { ascending: true });
  if (instErr) throw new Error(`Failed to load instances: ${instErr.message}`);
  if (!instances?.length) throw new Error("No frozen instances for optimization run");

  const rows: Parameters<typeof evaluateRun>[1] = [];
  const rolloutIdByInstance: Record<number, string> = {};
  for (const inst of instances) {
    const agentOutput = await invokeAgent(
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

    const { data: rollout, error: rErr } = await supabase
      .from("optimization_rollouts")
      .upsert(
        { candidate_id: candidateId, instance_index: inst.instance_index, phase, agent_output: agentOutput },
        { onConflict: "candidate_id,instance_index,phase" }
      )
      .select("id")
      .single();
    if (rErr || !rollout) throw new Error(`Failed to persist rollout: ${rErr?.message}`);
    rolloutIdByInstance[inst.instance_index] = rollout.id;

    rows.push({
      row_index: inst.instance_index,
      user_input: inst.user_input,
      agent_output: agentOutput,
      expected_output: inst.expected_output,
      retrieval_context: inst.retrieval_context,
    });
  }

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

  return { overallScore, instanceScores: perInstanceScores(results, rubric.criteria) };
}

export interface CompleteRunInput {
  optRunId: string;
  bestCandidateId: string;
  overallScore: number;
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
}

export async function failRun(input: { optRunId: string; message: string }): Promise<void> {
  await supabase
    .from("optimization_runs")
    .update({ status: "failed", error_message: input.message, updated_at: new Date().toISOString() })
    .eq("id", input.optRunId);
}

// ---- loaders ----

interface OptimizationRunRow {
  id: string;
  connection_id: string;
  rubric_id: string;
  eval_type: string;
}

async function loadRun(optRunId: string): Promise<OptimizationRunRow> {
  const { data, error } = await supabase
    .from("optimization_runs")
    .select("id, connection_id, rubric_id, eval_type")
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

// Decrypt the Connection's credential (full header value, e.g. "Bearer ..."), if any.
async function getAuthValue(authSecretId: string | null): Promise<string | null> {
  if (!authSecretId) return null;
  const { data, error } = await supabase.rpc("get_connection_auth", { p_secret_id: authSecretId });
  if (error) throw new Error(`Failed to read Connection credential: ${error.message}`);
  return (data as string) ?? null;
}
