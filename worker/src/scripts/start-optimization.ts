// Manual trigger for a GEPA Optimization Run against the local e2e seed — a dev tool for
// exercising the budgeted loop end-to-end without the UI. It mirrors the startOptimizationRun
// server action but runs from the worker so it can reuse the Temporal codec + connection seam
// directly (no Next bundle).
//
// It resolves the seeded org/rubric by name (so it survives a re-seed), ensures a dedicated
// "Opt demo (weak seed)" agent Connection exists (deliberately weak Module seeds give
// reflection real headroom — the seeded "Acme support agent" already has strong prompts),
// freezes a small support Q&A set, starts the durable workflow, polls Postgres until the run
// settles, then prints a summary of the candidates, rollouts, and best result.
//
// Prereqs (all running): local Supabase, the Temporal dev server, the worker
// (TEMPORAL_ENABLED=true), the mock agent (`node scripts/mock-agent.mjs`), and the e2e seed
// applied (`node scripts/seed-e2e.mjs`).
//
// Run from worker/:  node --env-file=.env.local --import tsx/esm src/scripts/start-optimization.ts

import { createClient } from "@supabase/supabase-js";
import { Client, Connection } from "@temporalio/client";
import { getDataConverter } from "../temporal/codec.js";
import { getTemporalEnv, OPTIMIZATION_TASK_QUEUE } from "../temporal/connection.js";

const ORG_NAME = "Acme Support (seed)";
const RUBRIC_NAME = "Support reply quality";
const AGENT_ENDPOINT = "http://localhost:8787/agent";

// OPT_DEMO_MANAGED=1 exercises a Managed Agent (#290): the run invokes Baseline's managed LLM
// directly instead of the mock HTTP agent. Needs a real Anthropic key for the seed org (a BYO
// provider_keys row, or the managed platform key for a paid Team) — resolveOptimizationKey
// fails the run closed otherwise. The external (mock-agent) path is the default and needs no key.
const DEMO_MANAGED = process.env.OPT_DEMO_MANAGED === "1";
const DEMO_CONNECTION_NAME = DEMO_MANAGED ? "Opt demo (managed)" : "Opt demo (weak seed)";
const MANAGED_TARGET_MODEL = "claude-haiku-4-5-20251001";

// Deliberately weak seeds: reflection has somewhere to go, so the accept path actually fires.
// The managed System is a single Module (its text becomes the system message); the external
// mock agent splices two Modules through its request template.
const WEAK_MODULES = DEMO_MANAGED
  ? [{ name: "system", seed: "Answer." }]
  : [
      { name: "system", seed: "Answer." },
      { name: "style", seed: "Reply." },
    ];

// Budget high enough that termination is by max-iters or plateau — the backstops worth
// observing. (Budget-as-terminator is its own trivial case: set budget below 2*minibatch.)
const BUDGET_ROLLOUTS = 200;
const MAX_ITERS = 5;
const PLATEAU_PATIENCE = 2;

// 4 answerable topics (the mock's KB) + 2 it can't answer. The unanswerable ones stay weak for
// every candidate, giving the Pareto frontier real per-instance diversity.
const INSTANCES: { user_input: string; expected_output: string }[] = [
  {
    user_input: "How do I reset my password?",
    expected_output:
      "Click “Forgot password” on the sign-in page, enter your email, and follow the link we send. The link expires in 30 minutes.",
  },
  {
    user_input: "What's your refund policy?",
    expected_output:
      "Full refund within 30 days of purchase, no questions asked — email billing@acme.test or use Billing → Request refund.",
  },
  {
    user_input: "What are your support hours?",
    expected_output:
      "Support is available Monday–Friday, 9am–6pm Eastern; message anytime and we reply the next business day.",
  },
  {
    user_input: "Can I export my data?",
    expected_output:
      "Yes — Settings → Data → Export downloads everything as a ZIP of CSV files; large accounts take a few minutes.",
  },
  {
    user_input: "Do you integrate with Salesforce?",
    expected_output:
      "No native Salesforce integration yet; export your data and import it manually, and tell us your use case so we can prioritize it.",
  },
  {
    user_input: "How do I cancel my subscription?",
    expected_output:
      "Cancel anytime under Settings → Billing → Cancel subscription; your plan stays active until the end of the current period.",
  },
];

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function resolveOrgId(): Promise<string> {
  const { data, error } = await supabase
    .from("organizations")
    .select("id")
    .eq("name", ORG_NAME)
    .maybeSingle();
  if (error || !data) {
    throw new Error(`Org "${ORG_NAME}" not found — run scripts/seed-e2e.mjs first.`);
  }
  return data.id as string;
}

async function resolveRubricId(orgId: string): Promise<string> {
  const { data, error } = await supabase
    .from("rubrics")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", RUBRIC_NAME)
    .maybeSingle();
  if (error || !data) throw new Error(`Rubric "${RUBRIC_NAME}" not found in org.`);
  return data.id as string;
}

async function resolveUserId(): Promise<string> {
  const { data, error } = await supabase.from("users").select("id").limit(1).single();
  if (error || !data) throw new Error(`No user to attribute the run to: ${error?.message}`);
  return data.id as string;
}

// Ensure the dedicated weak-seed demo Connection exists; reuse it across runs. Its prompts are
// never mutated by a run (Candidates hold the evolving prompts), so it stays a stable weak seed.
async function ensureDemoConnection(orgId: string, userId: string): Promise<string> {
  const { data: existing } = await supabase
    .from("connections")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", DEMO_CONNECTION_NAME)
    .maybeSingle();
  if (existing) return existing.id as string;

  // One literal (per-field conditionals) rather than two branch objects, so the typed insert
  // sees a single row shape (endpoint/target_model as string | null) instead of a union.
  const row = {
    org_id: orgId,
    created_by: userId,
    name: DEMO_CONNECTION_NAME,
    kind: "agent",
    agent_kind: DEMO_MANAGED ? "managed" : "external",
    provider: DEMO_MANAGED ? "anthropic" : "custom",
    target_model: DEMO_MANAGED ? MANAGED_TARGET_MODEL : null,
    endpoint: DEMO_MANAGED ? null : AGENT_ENDPOINT,
    auth_header: null,
    auth_secret_id: null,
    request_template: DEMO_MANAGED
      ? null
      : { input: "{{user_input}}", system: "{{prompt:system}}", style: "{{prompt:style}}" },
    response_path: DEMO_MANAGED ? null : "output",
    optimizable_prompts: WEAK_MODULES,
  };

  const { data, error } = await supabase.from("connections").insert(row).select("id").single();
  if (error || !data) throw new Error(`Failed to create demo connection: ${error?.message}`);
  console.log(`Created "${DEMO_CONNECTION_NAME}" connection ${data.id}`);
  return data.id as string;
}

async function main() {
  const orgId = await resolveOrgId();
  const rubricId = await resolveRubricId(orgId);
  const userId = await resolveUserId();
  const connectionId = await ensureDemoConnection(orgId, userId);

  // The partial unique index allows one active run per org. Free the slot if a previous dev run
  // is stuck queued/running (dev convenience only).
  const { data: active } = await supabase
    .from("optimization_runs")
    .select("id")
    .eq("org_id", orgId)
    .in("status", ["queued", "running"]);
  if (active?.length) {
    console.log(`Marking ${active.length} stuck active run(s) failed to free the org slot…`);
    await supabase
      .from("optimization_runs")
      .update({ status: "failed", error_message: "superseded by manual run" })
      .in(
        "id",
        active.map((r) => r.id)
      );
  }

  const { data: run, error: runErr } = await supabase
    .from("optimization_runs")
    .insert({
      org_id: orgId,
      created_by: userId,
      connection_id: connectionId,
      rubric_id: rubricId,
      eval_type: "tabular",
      budget_rollouts: BUDGET_ROLLOUTS,
      max_iters: MAX_ITERS,
      plateau_patience: PLATEAU_PATIENCE,
      status: "queued",
    })
    .select("id")
    .single();
  if (runErr || !run) throw new Error(`Failed to insert run: ${runErr?.message}`);
  const optRunId = run.id as string;

  const { error: inErr } = await supabase.from("optimization_inputs").insert(
    INSTANCES.map((row, i) => ({
      opt_run_id: optRunId,
      instance_index: i,
      user_input: row.user_input,
      expected_output: row.expected_output,
    }))
  );
  if (inErr) throw new Error(`Failed to freeze inputs: ${inErr.message}`);

  const { address, namespace, tls } = getTemporalEnv();
  const connection = await Connection.connect({ address, tls });
  const client = new Client({ connection, namespace, dataConverter: getDataConverter() });
  const workflowId = `opt-${optRunId}`;
  await client.workflow.start("runOptimizationWorkflow", {
    taskQueue: OPTIMIZATION_TASK_QUEUE,
    workflowId,
    args: [{ optRunId }],
  });
  await supabase.from("optimization_runs").update({ workflow_id: workflowId }).eq("id", optRunId);

  console.log(`\nStarted optimization run ${optRunId}`);
  console.log(`  workflow:  ${workflowId}  (Temporal UI: http://localhost:8233)`);
  console.log(
    `  knobs:     budget=${BUDGET_ROLLOUTS} max_iters=${MAX_ITERS} plateau_patience=${PLATEAU_PATIENCE}`
  );
  console.log(`  instances: ${INSTANCES.length} (minibatch = min(5, n))\n`);

  await poll(optRunId);
  await connection.close();
}

async function poll(optRunId: string) {
  const deadline = Date.now() + 10 * 60_000;
  let status = "queued";
  while (Date.now() < deadline) {
    const { data } = await supabase
      .from("optimization_runs")
      .select("status")
      .eq("id", optRunId)
      .single();
    status = data?.status ?? status;
    if (status === "completed" || status === "failed") break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  await summarize(optRunId, status);
}

async function summarize(optRunId: string, status: string) {
  const { data: run } = await supabase
    .from("optimization_runs")
    .select("status, best_candidate_id, best_score, error_message")
    .eq("id", optRunId)
    .single();

  const { data: candidates } = await supabase
    .from("optimization_candidates")
    .select("id, generation, iteration, target_module, prompts")
    .eq("opt_run_id", optRunId)
    .order("generation", { ascending: true });

  console.log("──────────────────────────────────────────────────────────────");
  console.log(`RUN ${optRunId}`);
  console.log(`  status:     ${run?.status ?? status}`);
  console.log(`  best_score: ${run?.best_score ?? "—"}`);
  if (run?.error_message) console.log(`  error:      ${run.error_message}`);
  // Pull every candidate's rollouts in ONE read keyed by candidate id, then count
  // per-candidate in memory — rather than one query per candidate (an N+1 that grew
  // with the run's candidate count). Mirrors the production .in("candidate_id", …)
  // batch in src/app/actions/optimizations.ts.
  const candidateIds = (candidates ?? []).map((c) => c.id as string);
  const { data: allRollouts } = candidateIds.length
    ? await supabase
        .from("optimization_rollouts")
        .select("candidate_id, phase")
        .in("candidate_id", candidateIds)
    : { data: [] as { candidate_id: string; phase: string }[] };
  const rolloutsByCandidate = new Map<string, { mini: number; pareto: number }>();
  for (const r of allRollouts ?? []) {
    const counts = rolloutsByCandidate.get(r.candidate_id) ?? { mini: 0, pareto: 0 };
    if (r.phase === "minibatch") counts.mini += 1;
    else if (r.phase === "pareto") counts.pareto += 1;
    rolloutsByCandidate.set(r.candidate_id, counts);
  }

  console.log("");
  console.log("CANDIDATES (gen · iter · module · rollouts · is-best):");
  for (const c of candidates ?? []) {
    const id = c.id as string;
    const { mini, pareto } = rolloutsByCandidate.get(id) ?? { mini: 0, pareto: 0 };
    const best = id === run?.best_candidate_id ? "  ◀ BEST" : "";
    console.log(
      `  gen ${c.generation} · iter ${c.iteration ?? "seed"} · ${
        c.target_module ?? "(seed)"
      } · rollouts[mini=${mini} pareto=${pareto}]${best}`
    );
  }

  const best = (candidates ?? []).find((c) => c.id === run?.best_candidate_id);
  const seed = (candidates ?? []).find((c) => c.generation === 0);
  if (best && seed && best.id !== seed.id) {
    console.log("\nBEST CANDIDATE PROMPTS (vs seed):");
    for (const mod of Object.keys(best.prompts as Record<string, string>)) {
      const seedText = (seed.prompts as Record<string, string>)[mod];
      const bestText = (best.prompts as Record<string, string>)[mod];
      const changed = seedText !== bestText ? "CHANGED" : "unchanged";
      console.log(`  [${mod}] ${changed}`);
      console.log(`    seed: ${JSON.stringify(seedText)}`);
      console.log(`    best: ${JSON.stringify(bestText).slice(0, 240)}`);
    }
  }
  console.log("──────────────────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
