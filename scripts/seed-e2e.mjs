// Full end-to-end demo seed: one signed-in user with a populated team — rubrics,
// completed eval runs (with a score trend for the dashboard), a schedule with run
// history, and a completed optimization run. Lets you exercise dashboards, rubrics,
// eval runs, schedules, and optimizations without driving the worker/Temporal/mock.
//
// All data is seeded in a TERMINAL state (runs already 'completed' with rows + results),
// so every screen is populated immediately. To exercise the LIVE paths (worker invocation,
// the GEPA workflow), use scripts/README-schedules-e2e.md + scripts/mock-agent.mjs instead.
//
// DEV / STAGING ONLY — NEVER PRODUCTION. The guard below hard-refuses on any production
// marker and requires an explicit opt-in. Run with:
//
//   SEED_ENV=development npm run seed:e2e
//   SEED_ENV=staging     node --env-file=.env.staging scripts/seed-e2e.mjs
//
// Re-running is idempotent: it tears down the prior seed team + user first, then recreates.

import { createClient } from "@supabase/supabase-js";

// ----------------------------------------------------------------------------
// Guard: never production.
// ----------------------------------------------------------------------------

const SEED_ENV = process.env.SEED_ENV;
const ALLOWED_ENVS = new Set(["development", "staging"]);

function abort(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// Hard block: refuse on ANY production marker, regardless of SEED_ENV. This is the
// non-negotiable safety net — even a mistaken SEED_ENV=production-adjacent value can't
// get past it.
if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production") {
  abort(
    "Refusing to seed: a production marker is set " +
      `(NODE_ENV=${process.env.NODE_ENV ?? "unset"}, VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}). ` +
      "This script must never touch production data."
  );
}

// Explicit opt-in: the operator must name the non-prod environment they intend to seed.
// Team C (the paid e2e fixture) needs a Builder price id; check up front so a
// missing env aborts before any team is created, not mid-seed.
if (!process.env.STRIPE_PRICE_BUILDER) {
  abort("STRIPE_PRICE_BUILDER is required (Team C's Builder subscription) — set it in .env.local");
}

if (!ALLOWED_ENVS.has(SEED_ENV ?? "")) {
  abort(
    `Set SEED_ENV to one of: ${[...ALLOWED_ENVS].join(", ")} (got ${SEED_ENV ?? "unset"}).\n` +
      "  Example:  SEED_ENV=development npm run seed:e2e"
  );
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  abort("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.");
}

// A development seed pointed at a non-local database is almost certainly a misconfig
// (e.g. SEED_ENV left as 'development' while .env points at staging). Warn loudly.
const isLocalHost = /localhost|127\.0\.0\.1|::1/.test(SUPABASE_URL);
if (SEED_ENV === "development" && !isLocalHost) {
  console.warn(
    `\n⚠ SEED_ENV=development but the target is not local (${SUPABASE_URL}). ` +
      "Use SEED_ENV=staging if this is intentional.\n"
  );
}

console.log(`\nSeeding [${SEED_ENV}] → ${SUPABASE_URL}`);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ----------------------------------------------------------------------------
// Fixtures.
// ----------------------------------------------------------------------------

const PASSWORD = "password123";
// Team A (primary demo team): an admin (named CONTRIBUTOR_A here to mirror e2e/constants.ts,
// which independently defines the same constant names — see #512) and a Readonly Member, so
// the UI's view-only restrictions can be exercised by signing in as each.
const CONTRIBUTOR_A = { email: "dev@baseline.test", password: PASSWORD };
const READONLY_A = { email: "readonly@baseline.test", password: PASSWORD };
// Team B (isolation fixture): its own admin, used to prove a Team A user cannot
// reach Team B's resources.
const CONTRIBUTOR_B = { email: "dev-b@baseline.test", password: PASSWORD };
// Team C (paid fixture): a Builder-subscribed Team for surfaces that require a paid
// plan — the optimization wizard and allowance metering (#181). Subscribed via a
// seeded customers mirror row, no webhook required.
const CONTRIBUTOR_C = { email: "dev-c@baseline.test", password: PASSWORD };
// Team D (BYO paid fixture, #485): a Builder-subscribed Team WITH BYO provider keys (OpenAI +
// Mistral), so the live-model-listing surfaces have a home that never disturbs Team C's
// deliberately keyless managed-mode state (which the managed-metering specs rely on).
const CONTRIBUTOR_D = { email: "dev-d@baseline.test", password: PASSWORD };
const SEED_EMAILS = [
  CONTRIBUTOR_A.email,
  READONLY_A.email,
  CONTRIBUTOR_B.email,
  CONTRIBUTOR_C.email,
  CONTRIBUTOR_D.email,
];

const ORG_NAME = "Acme Support (seed)"; // Team A
const ORG_B_NAME = "Globex Sales (seed)"; // Team B
const ORG_C_NAME = "Initech Data (seed)"; // Team C (Builder)
const ORG_D_NAME = "Umbrella Labs (seed)"; // Team D (Builder + BYO keys, #485)
// Defaults to the local mock (scripts/mock-agent.mjs). Override for staging so a live
// optimization started from the UI hits a reachable endpoint, e.g.
// SEED_AGENT_ENDPOINT=https://mock.staging.example.com/agent
const AGENT_ENDPOINT = process.env.SEED_AGENT_ENDPOINT ?? "http://localhost:8787/agent";
// Dataset twin of the mock (same server, GET /logs — see scripts/mock-agent.mjs). Feeds the
// optimization wizard's dataset-snapshot Instances source (#82). NOTE: the SSRF egress guard
// refuses loopback even in dev, so against the local default the wizard tab/picker render and
// the refusal path is exercisable, but a live snapshot needs a publicly reachable mock:
// SEED_DATASET_ENDPOINT=https://mock.staging.example.com/logs
const DATASET_ENDPOINT = process.env.SEED_DATASET_ENDPOINT ?? "http://localhost:8787/logs";

// Two optimizable Modules so the UI exercises the multi-module case (D2), not just N=1.
const MODULES = [
  {
    name: "system",
    seed: "You are a friendly, accurate support agent for Acme. Answer concisely and resolve the user's question.",
  },
  {
    name: "style",
    seed: "Use a warm, professional tone. Prefer short paragraphs and concrete next steps.",
  },
];
const SEED_PROMPTS = Object.fromEntries(MODULES.map((m) => [m.name, m.seed]));

// The winning Candidate's prompts — a plausible reflective-mutation improvement over the seed
// (more specific instructions per Module). Drives a visible seed→optimized diff + score lift in
// the completed-run view.
const IMPROVED_PROMPTS = {
  system:
    "You are a friendly, accurate support agent for Acme. Resolve the user's question in full: " +
    "answer the exact question asked, cite the relevant policy or limit when one applies, and end " +
    "with the single most useful next step. If you are unsure, say so and point to how the user can " +
    "confirm rather than guessing.",
  style:
    "Use a warm, professional tone. Open with the answer, not a preamble. Prefer short paragraphs " +
    "and concrete, numbered next steps over generic reassurance. Mirror the user's terminology.",
};

// Canned support Q&A (mirrors scripts/mock-agent.mjs so live + seeded data line up).
const SUPPORT_ROWS = [
  {
    user_input: "How do I reset my password?",
    expected_output: "Click “Forgot password”, enter your email, and use the emailed link (expires ~30 min).",
    agent_output:
      "To reset your password, click “Forgot password” on the sign-in page, enter your email, and follow the link we send you. The link expires in 30 minutes.",
  },
  {
    user_input: "What's your refund policy?",
    expected_output: "Full refund within 30 days; via billing email or in-app Billing → Request refund.",
    agent_output:
      "We offer a full refund within 30 days of purchase. Email billing@acme.test or use Billing → Request refund in the app.",
  },
  {
    user_input: "What are your support hours?",
    expected_output: "Mon–Fri, 9am–6pm Eastern; async replies next business day.",
    agent_output:
      "Our support team is available Monday–Friday, 9am–6pm Eastern. Message us anytime and we’ll reply the next business day.",
  },
  {
    user_input: "Can I export my data?",
    expected_output: "Settings → Data → Export; downloads a ZIP of CSVs.",
    agent_output: "Yes — go to Settings → Data → Export to download everything as a ZIP of CSV files.",
  },
  {
    user_input: "Do you integrate with Salesforce?",
    expected_output: "Should clearly state whether a Salesforce integration exists.",
    // Deliberately weak so this row scores lower — a realistic spread.
    agent_output: "Thanks for reaching out! Someone from our team will look into that and get back to you.",
  },
];

const RUBRICS = [
  {
    name: "Support reply quality",
    scenario_description:
      "A customer asks a support question; the agent must answer correctly, completely, and kindly.",
    expected_outcome: "An accurate, complete, friendly answer that resolves the customer's question.",
    evaluation_mode: "prompt_response",
    grounding_context: null,
    criteria: [
      { name: "Accuracy", weight: 0.5, steps: ["Compare the answer to the expected answer.", "Penalize factual errors or omissions."] },
      { name: "Completeness", weight: 0.3, steps: ["Check the key steps/details a user needs are present."] },
      { name: "Tone", weight: 0.2, steps: ["Assess friendliness and professionalism."] },
    ],
  },
  {
    name: "Sales email quality",
    scenario_description: "An outbound sales email drafted by the agent in response to a lead's context.",
    expected_outcome: "A persuasive, clear, concise email with a single clear call to action.",
    evaluation_mode: "prompt_response",
    grounding_context: null,
    criteria: [
      { name: "Persuasiveness", weight: 0.5, steps: ["Does it make a compelling, relevant case?"] },
      { name: "Clarity", weight: 0.3, steps: ["Is the ask and value proposition unambiguous?"] },
      { name: "Brevity", weight: 0.2, steps: ["Is it free of filler and appropriately short?"] },
    ],
  },
];

// ----------------------------------------------------------------------------
// Helpers.
// ----------------------------------------------------------------------------

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}
function round3(n) {
  return Math.round(n * 1000) / 1000;
}
function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

async function insertRows(table, rows, select) {
  const query = supabase.from(table).insert(rows);
  const { data, error } = select ? await query.select(select) : await query;
  if (error) throw new Error(`insert into ${table} failed: ${error.message}`);
  return data;
}

async function insertOne(table, row, select = "id") {
  const data = await insertRows(table, row, select);
  return data[0];
}

// Build per-row, per-criterion results around a target run quality `base`. Accuracy reads a
// touch below base, Tone a touch above, with mild per-row jitter — and the weak last row
// (Salesforce) is dragged down so the spread looks real. Returns the result rows plus the
// run's weighted overall (per-criterion mean across rows, then weighted — matching evaluateRun).
function buildRunResults(criteria, rowCount, base) {
  const offsetByIndex = (i) => (criteria.length === 3 ? [-0.05, 0, 0.05][i] : 0);
  const results = [];
  const critMeans = new Map(criteria.map((c) => [c.name, { sum: 0, n: 0 }]));

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const weakRow = rowIndex === rowCount - 1 ? 0.18 : 0; // last row underperforms
    const jitter = ((rowIndex % 3) - 1) * 0.03;
    criteria.forEach((crit, ci) => {
      const score = round3(clamp01(base + offsetByIndex(ci) + jitter - weakRow));
      results.push({ rowIndex, criterionName: crit.name, score });
      const m = critMeans.get(crit.name);
      m.sum += score;
      m.n += 1;
    });
  }

  const overall = round3(
    criteria.reduce((total, c) => {
      const m = critMeans.get(c.name);
      return total + c.weight * (m.sum / m.n);
    }, 0)
  );
  return { results, overall };
}

// ----------------------------------------------------------------------------
// Teardown (idempotency): remove the prior seed team + user so a re-run is clean.
// ----------------------------------------------------------------------------

async function teardown() {
  // Collect every seed auth user by email (paginate defensively).
  const seedUsers = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    seedUsers.push(...data.users.filter((u) => SEED_EMAILS.includes(u.email)));
    if (data.users.length < 200) break;
  }
  if (!seedUsers.length) return;

  // Delete the orgs these users belong to — cascades memberships, rubrics (→ eval_runs →
  // rows/results), connections, schedules, and optimization_runs (→ candidates/inputs/
  // rollouts/results). Then delete the auth users (cascades public.users).
  const userIds = seedUsers.map((u) => u.id);
  const { data: memberships } = await supabase
    .from("memberships")
    .select("org_id")
    .in("user_id", userIds);
  const orgIds = [...new Set((memberships ?? []).map((m) => m.org_id))];
  if (orgIds.length) {
    const { error } = await supabase.from("organizations").delete().in("id", orgIds);
    if (error) throw new Error(`failed to delete prior seed orgs: ${error.message}`);
  }
  for (const u of seedUsers) {
    const { error } = await supabase.auth.admin.deleteUser(u.id);
    if (error) throw new Error(`failed to delete prior seed user ${u.email}: ${error.message}`);
  }
  console.log("  cleared prior seed data");
}

// Create a pre-confirmed auth user (so it can sign in immediately) and return its id.
async function createUser({ email, password }) {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data?.user) throw new Error(`createUser(${email}) failed: ${error?.message}`);
  return data.user.id;
}

// ----------------------------------------------------------------------------
// Seed.
// ----------------------------------------------------------------------------

async function seed() {
  await teardown();

  // 1) Team A: an admin + a Readonly Member (member), so the UI's view-only
  //    restrictions can be exercised by signing in as each.
  const userId = await createUser(CONTRIBUTOR_A);
  const org = await insertOne("organizations", { name: ORG_NAME });
  await insertRows("memberships", { org_id: org.id, user_id: userId, role: "admin" });

  const readonlyUserId = await createUser(READONLY_A);
  await insertRows("memberships", { org_id: org.id, user_id: readonlyUserId, role: "member" });

  // BYO provider key (#184): Team A is a Free Team, and a Free Team with no key
  // is refused at the run action's key gate *before* any billing gate. The Eval
  // Point and overage specs need to reach those billing gates, so give Team A a
  // dummy key — the gate checks presence, not validity, and the e2e stack never
  // scores against a live provider. Stored via the same RPC the app uses (Vault).
  const { error: keyError } = await supabase.rpc("set_provider_key", {
    p_org_id: org.id,
    p_provider: "anthropic",
    p_secret: "sk-ant-e2e-team-a-seed-key",
    p_last4: "-key",
    p_created_by: userId,
  });
  if (keyError) abort(`seeding Team A provider key failed: ${keyError.message}`);

  // 2) Rubrics.
  const rubricIds = [];
  for (const r of RUBRICS) {
    const rubric = await insertOne("rubrics", {
      created_by: userId,
      org_id: org.id,
      name: r.name,
      scenario_description: r.scenario_description,
      expected_outcome: r.expected_outcome,
      evaluation_mode: r.evaluation_mode,
      grounding_context: r.grounding_context,
      criteria: r.criteria,
    });
    rubricIds.push(rubric.id);
  }

  // 3) Agent connection with one optimizable Module ({{prompt:system}}), so the optimization
  //    surface has a real System to point at. Endpoint is the local mock (live runs only).
  const connection = await insertOne("connections", {
    org_id: org.id,
    created_by: userId,
    name: "Acme support agent (seed)",
    kind: "agent",
    provider: "custom",
    endpoint: AGENT_ENDPOINT,
    auth_header: null,
    auth_secret_id: null,
    request_template: { input: "{{user_input}}", system: "{{prompt:system}}", style: "{{prompt:style}}" },
    response_path: "output",
    optimizable_prompts: MODULES,
  });

  // 4) Completed eval runs with a rising score trend so the dashboard has a story to tell.
  //    Five runs per rubric over ~75 days. Returns run ids for linking to the schedule.
  const SCHEDULE_AT = [60, 30]; // two of rubric A's runs are attributed to the schedule
  const runIdsByRubric = [[], []];
  const trend = [
    { day: 75, base: 0.62 },
    { day: 60, base: 0.69 },
    { day: 45, base: 0.75 },
    { day: 30, base: 0.82 },
    { day: 12, base: 0.88 },
  ];

  for (let ri = 0; ri < RUBRICS.length; ri++) {
    const rubric = RUBRICS[ri];
    const rows = ri === 0 ? SUPPORT_ROWS : SUPPORT_ROWS; // reuse the canned rows for both
    for (const point of trend) {
      const { results, overall } = buildRunResults(rubric.criteria, rows.length, point.base);
      const createdAt = daysAgo(point.day);
      const run = await insertOne("eval_runs", {
        created_by: userId,
        rubric_id: rubricIds[ri],
        status: "completed",
        eval_type: "tabular",
        description: `${rubric.name} — seeded run`,
        overall_score: overall,
        created_at: createdAt,
        updated_at: createdAt,
      });
      runIdsByRubric[ri].push({ id: run.id, day: point.day });

      await insertRows(
        "eval_run_rows",
        rows.map((row, i) => ({
          eval_run_id: run.id,
          row_index: i,
          user_input: row.user_input,
          agent_output: row.agent_output,
          expected_output: row.expected_output,
          retrieval_context: null,
        }))
      );
      await insertRows(
        "eval_run_results",
        results.map((res) => ({
          eval_run_id: run.id,
          row_index: res.rowIndex,
          criterion_name: res.criterionName,
          score: res.score,
          reasoning: `Seeded ${res.criterionName} score for demo.`,
        }))
      );
    }
  }

  // 5) Schedule (agent kind) with its fixed input set, plus run history (attribute two of
  //    rubric A's completed runs to it).
  const nextRun = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const schedule = await insertOne("schedules", {
    org_id: org.id,
    created_by: userId,
    rubric_id: rubricIds[0],
    connection_id: connection.id,
    name: "Support agent — nightly (seed)",
    description: "Nightly quality check of the support agent.",
    eval_type: "tabular",
    frequency: "daily",
    local_hour: 9,
    timezone: "UTC",
    enabled: true,
    notification_emails: [],
    next_run_at: nextRun,
    last_run_at: daysAgo(1),
  });

  await insertRows(
    "schedule_inputs",
    SUPPORT_ROWS.map((row, i) => ({
      schedule_id: schedule.id,
      row_index: i,
      user_input: row.user_input,
      expected_output: row.expected_output,
      retrieval_context: null,
    }))
  );

  const scheduleRunIds = runIdsByRubric[0]
    .filter((r) => SCHEDULE_AT.includes(r.day))
    .map((r) => r.id);
  if (scheduleRunIds.length) {
    const { error } = await supabase
      .from("eval_runs")
      .update({ schedule_id: schedule.id })
      .in("id", scheduleRunIds);
    if (error) throw new Error(`failed to link schedule runs: ${error.message}`);
  }

  // 6) Completed optimization run: candidate 0 (seed prompts), frozen instances, and a
  //    rollout per instance with per-criterion results. best_candidate = the seed.
  const rubricA = RUBRICS[0];
  const optRun = await insertOne("optimization_runs", {
    org_id: org.id,
    created_by: userId,
    connection_id: connection.id,
    rubric_id: rubricIds[0],
    eval_type: "tabular",
    budget_rollouts: 20,
    max_iters: 10,
    reflect_model: "claude-sonnet-4-6",
    status: "completed",
    created_at: daysAgo(5),
    updated_at: daysAgo(5),
  });

  const candidate = await insertOne("optimization_candidates", {
    opt_run_id: optRun.id,
    parent_id: null,
    generation: 0,
    prompts: SEED_PROMPTS,
  });

  await insertRows(
    "optimization_inputs",
    SUPPORT_ROWS.map((row, i) => ({
      opt_run_id: optRun.id,
      instance_index: i,
      user_input: row.user_input,
      expected_output: row.expected_output,
      retrieval_context: null,
    }))
  );

  const { results: optResults, overall: optOverall } = buildRunResults(
    rubricA.criteria,
    SUPPORT_ROWS.length,
    0.8
  );
  const rolloutIdByInstance = {};
  for (let i = 0; i < SUPPORT_ROWS.length; i++) {
    const rollout = await insertOne("optimization_rollouts", {
      candidate_id: candidate.id,
      instance_index: i,
      phase: "pareto",
      agent_output: SUPPORT_ROWS[i].agent_output,
      trace: null,
    });
    rolloutIdByInstance[i] = rollout.id;
  }
  await insertRows(
    "rollout_results",
    optResults.map((res) => ({
      rollout_id: rolloutIdByInstance[res.rowIndex],
      criterion_name: res.criterionName,
      score: res.score,
      reasoning: `Seeded ${res.criterionName} score for demo.`,
    }))
  );

  // A winning Candidate (generation 1) descended from the seed via reflective mutation — it
  // beats the seed on the Pareto set, so it becomes best_candidate. This is what makes the
  // completed-run view show a real seed→optimized prompt diff and score lift.
  const winner = await insertOne("optimization_candidates", {
    opt_run_id: optRun.id,
    parent_id: candidate.id,
    generation: 1,
    iteration: 1,
    target_module: "system",
    prompts: IMPROVED_PROMPTS,
  });

  const { results: winnerResults, overall: winnerOverall } = buildRunResults(
    rubricA.criteria,
    SUPPORT_ROWS.length,
    0.92
  );
  const winnerRolloutIdByInstance = {};
  for (let i = 0; i < SUPPORT_ROWS.length; i++) {
    const rollout = await insertOne("optimization_rollouts", {
      candidate_id: winner.id,
      instance_index: i,
      phase: "pareto",
      agent_output: SUPPORT_ROWS[i].agent_output,
      trace: null,
    });
    winnerRolloutIdByInstance[i] = rollout.id;
  }
  await insertRows(
    "rollout_results",
    winnerResults.map((res) => ({
      rollout_id: winnerRolloutIdByInstance[res.rowIndex],
      criterion_name: res.criterionName,
      score: res.score,
      reasoning: `Seeded ${res.criterionName} score for the optimized candidate.`,
    }))
  );

  const { error: completeError } = await supabase
    .from("optimization_runs")
    .update({
      best_candidate_id: winner.id,
      best_score: winnerOverall,
      // Mirror the workflow id the server action assigns, so a future UI that surfaces or
      // links it isn't blank.
      workflow_id: `opt-${optRun.id}`,
    })
    .eq("id", optRun.id);
  if (completeError) throw new Error(`failed to finalize optimization run: ${completeError.message}`);

  // Ledger truth for the run above: Free's ONE lifetime Optimization Run
  // (optimizationRunsGrant "lifetime") derives its effective count from
  // optimization_lifetime_used — net reserves minus releases across ALL
  // periods — so a completed run with Rollouts must have consumed a unit or
  // Team A would show "1 available" next to a finished run it never paid a
  // unit for. Bucketed into a synthetic PAST month so it can never collide
  // with the current period's lazy grant (the lifetime sum is period-agnostic).
  const monthStartUtc = (offset) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString();
  };
  const pastPeriod = { period_start: monthStartUtc(-1), period_end: monthStartUtc(0) };
  // meta is explicit on every row: a PostgREST bulk insert null-fills keys
  // missing from some rows, which trips the column's NOT NULL despite its
  // default.
  await insertRows("optimization_run_ledger", [
    { org_id: org.id, entry_type: "grant", units: 1, meta: {}, ...pastPeriod },
    // meta.lifetime is what optimization_lifetime_used counts (#501, CR-3):
    // an untagged reserve reads as paid per-period usage and would leave
    // Team A showing "1 available" beside its finished run.
    { org_id: org.id, entry_type: "reserve", units: 1, opt_run_id: optRun.id, meta: { lifetime: true }, ...pastPeriod },
    // What settle_optimization_run derives for a run whose Rollouts executed.
    { org_id: org.id, entry_type: "settle", units: 1, opt_run_id: optRun.id, meta: { worked: true }, ...pastPeriod },
  ]);

  // 7) Team B — a second, fully separate Team that proves tenant isolation: a Team A user
  //    must not be able to reach this Team's rubric. Kept deliberately small (one rubric,
  //    one completed run) so it has a populated read path of its own.
  const userBId = await createUser(CONTRIBUTOR_B);
  const orgB = await insertOne("organizations", { name: ORG_B_NAME });
  await insertRows("memberships", { org_id: orgB.id, user_id: userBId, role: "admin" });

  const teamBRubricDef = {
    name: "Globex outbound email quality (seed)",
    scenario_description: "An outbound sales email drafted for a Globex lead.",
    expected_outcome: "A concise, persuasive email with one clear call to action.",
    evaluation_mode: "prompt_response",
    grounding_context: null,
    criteria: [
      { name: "Persuasiveness", weight: 0.6, steps: ["Does it make a compelling, relevant case?"] },
      { name: "Clarity", weight: 0.4, steps: ["Is the ask unambiguous?"] },
    ],
  };
  const rubricB = await insertOne("rubrics", {
    created_by: userBId,
    org_id: orgB.id,
    name: teamBRubricDef.name,
    scenario_description: teamBRubricDef.scenario_description,
    expected_outcome: teamBRubricDef.expected_outcome,
    evaluation_mode: teamBRubricDef.evaluation_mode,
    grounding_context: teamBRubricDef.grounding_context,
    criteria: teamBRubricDef.criteria,
  });

  {
    const { results, overall } = buildRunResults(teamBRubricDef.criteria, SUPPORT_ROWS.length, 0.79);
    const createdAt = daysAgo(10);
    const runB = await insertOne("eval_runs", {
      created_by: userBId,
      rubric_id: rubricB.id,
      status: "completed",
      eval_type: "tabular",
      description: `${teamBRubricDef.name} — seeded run`,
      overall_score: overall,
      created_at: createdAt,
      updated_at: createdAt,
    });
    await insertRows(
      "eval_run_rows",
      SUPPORT_ROWS.map((row, i) => ({
        eval_run_id: runB.id,
        row_index: i,
        user_input: row.user_input,
        agent_output: row.agent_output,
        expected_output: row.expected_output,
        retrieval_context: null,
      }))
    );
    await insertRows(
      "eval_run_results",
      results.map((res) => ({
        eval_run_id: runB.id,
        row_index: res.rowIndex,
        criterion_name: res.criterionName,
        score: res.score,
        reasoning: `Seeded ${res.criterionName} score for demo.`,
      }))
    );
  }

  // 8) Team C — the paid fixture (#181): Builder-subscribed via a seeded mirror row,
  //    with its own rubric and agent connection so paid-only surfaces (the optimization
  //    wizard, allowance gating) have a stable home that doesn't race the billing
  //    webhook specs (which own Team B's subscription state).
  const builderPrice = process.env.STRIPE_PRICE_BUILDER;
  const userCId = await createUser(CONTRIBUTOR_C);
  const orgC = await insertOne("organizations", { name: ORG_C_NAME });
  await insertRows("memberships", { org_id: orgC.id, user_id: userCId, role: "admin" });

  const RUBRIC_C_CRITERIA = [
    { name: "Routing accuracy", weight: 0.7, steps: ["Did it pick the right queue?"] },
    { name: "Priority fit", weight: 0.3, steps: ["Is the priority justified?"] },
  ];
  const rubricC = await insertOne("rubrics", {
    created_by: userCId,
    org_id: orgC.id,
    name: "Initech ticket triage (seed)",
    scenario_description: "A support ticket routed by the Initech triage agent.",
    expected_outcome: "The ticket reaches the right queue with a correct priority.",
    evaluation_mode: "prompt_response",
    grounding_context: null,
    criteria: RUBRIC_C_CRITERIA,
  });

  await insertOne("connections", {
    org_id: orgC.id,
    created_by: userCId,
    name: "Initech triage agent (seed)",
    kind: "agent",
    provider: "custom",
    endpoint: AGENT_ENDPOINT,
    auth_header: null,
    auth_secret_id: null,
    request_template: { input: "{{user_input}}", system: "{{prompt:system}}", style: "{{prompt:style}}" },
    response_path: "output",
    optimizable_prompts: MODULES,
  });

  // Dataset Connection against the mock's GET /logs, so the paid Team exercises the
  // optimization wizard's dataset-snapshot Instances source (#82): the tab appears, the
  // picker lists this Connection, and the window/cap params flow through the shared
  // custom-dataset adapter contract (?from/&to/&limit → {"data":[{prompt, completion}]}).
  await insertOne("connections", {
    org_id: orgC.id,
    created_by: userCId,
    name: "Initech traffic logs (seed)",
    kind: "dataset",
    provider: "custom",
    endpoint: DATASET_ENDPOINT,
    auth_header: null,
    auth_secret_id: null,
    request_template: { from: "{{window_start}}", to: "{{window_end}}", limit: "{{max_rows}}" },
    response_path: "data",
    optimizable_prompts: null,
    config: { field_map: { user_input: "prompt", agent_output: "completion" } },
  });

  // Two completed eval runs so the paid Team exercises the optimization wizard's
  // "From an Eval Run" Instances source (#83): the tab appears and the picker offers a
  // recent 8-row run (with retrieval_context on some rows, so all three copied fields are
  // visible downstream) and an older 3-row one. agent_output is present on every row and
  // must NOT survive the copy into optimization_inputs.
  const TRIAGE_ROWS = [
    {
      user_input: "I was charged twice for my March invoice and need one of the charges refunded.",
      expected_output: "Queue: billing. Priority: high.",
      agent_output: "Queue: billing. Priority: high. Duplicate charge on the March invoice.",
      retrieval_context: "Billing policy: duplicate charges are refunded within 5 business days.",
    },
    {
      user_input: "The dashboard has returned a 500 error since 9am and my whole team is blocked.",
      expected_output: "Queue: technical. Priority: urgent.",
      agent_output: "Queue: technical. Priority: urgent. Production outage blocking the customer's team.",
      retrieval_context: "Escalation rule: production outages page the on-call engineer.",
    },
    {
      user_input: "How do I add a new teammate to my workspace?",
      expected_output: "Queue: account. Priority: low.",
      agent_output: "Queue: account. Priority: low. Customer asks how to invite a teammate.",
      retrieval_context: null,
    },
    {
      user_input: "Can I get an invoice with our VAT number on it?",
      expected_output: "Queue: billing. Priority: normal.",
      agent_output: "Queue: billing. Priority: normal. Customer needs a VAT invoice.",
      retrieval_context: null,
    },
    {
      user_input: "Exports keep timing out for files over 10k rows.",
      expected_output: "Queue: technical. Priority: high.",
      agent_output: "Queue: technical. Priority: high. Large exports failing with timeouts.",
      retrieval_context: "Known issue: exports >10k rows time out; workaround is chunked export.",
    },
    {
      user_input: "I think someone accessed my account from another country.",
      expected_output: "Queue: account. Priority: urgent.",
      agent_output: "Queue: account. Priority: urgent. Possible account compromise reported.",
      retrieval_context: "Security rule: suspected compromise is urgent and triggers a forced reset.",
    },
    {
      user_input: "Is there a student discount?",
      expected_output: "Queue: general. Priority: low.",
      agent_output: "Queue: general. Priority: low. Pricing question about student discounts.",
      retrieval_context: null,
    },
    {
      user_input: "The mobile app crashes when I open the reports tab.",
      expected_output: "Queue: technical. Priority: normal.",
      agent_output: "Queue: technical. Priority: normal. Mobile crash in the reports tab.",
      retrieval_context: null,
    },
  ];
  const teamCRuns = [
    { description: "Prod triage sample — last week", rows: TRIAGE_ROWS, day: 6, base: 0.81 },
    { description: "Pilot batch — first triage eval", rows: TRIAGE_ROWS.slice(0, 3), day: 40, base: 0.66 },
  ];
  for (const spec of teamCRuns) {
    const { results, overall } = buildRunResults(RUBRIC_C_CRITERIA, spec.rows.length, spec.base);
    const createdAt = daysAgo(spec.day);
    const runC = await insertOne("eval_runs", {
      created_by: userCId,
      rubric_id: rubricC.id,
      status: "completed",
      eval_type: "tabular",
      description: spec.description,
      overall_score: overall,
      created_at: createdAt,
      updated_at: createdAt,
    });
    await insertRows(
      "eval_run_rows",
      spec.rows.map((row, i) => ({
        eval_run_id: runC.id,
        row_index: i,
        user_input: row.user_input,
        agent_output: row.agent_output,
        expected_output: row.expected_output,
        retrieval_context: row.retrieval_context,
      }))
    );
    await insertRows(
      "eval_run_results",
      results.map((res) => ({
        eval_run_id: runC.id,
        row_index: res.rowIndex,
        criterion_name: res.criterionName,
        score: res.score,
        reasoning: `Seeded ${res.criterionName} score for demo.`,
      }))
    );
  }

  await insertRows("customers", {
    org_id: orgC.id,
    stripe_customer_id: `cus_seed_${orgC.id}`,
    stripe_subscription_id: `sub_seed_${orgC.id}`,
    status: "active",
    stripe_price_id: builderPrice,
    current_period_start: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    current_period_end: new Date(Date.now() + 25 * 86_400_000).toISOString(),
    mirror_event_at: new Date().toISOString(),
    email: CONTRIBUTOR_C.email,
  });

  // 9) Team D — the BYO paid fixture (#485): Builder-subscribed AND holding BYO provider keys
  //    (OpenAI usable, Mistral usable), so the optimization wizard's live-model listing has a
  //    stable home. Kept separate from Team C on purpose: Team C's keyless managed-mode state
  //    is load-bearing for the managed-metering/upsell specs, and a BYO key would flip its
  //    judge/key-mode resolution. The e2e run points the *_API_BASE_OVERRIDE env vars at a
  //    local mock (e2e/provider-models-mock-server.mjs): OpenAI's listing serves an extra model
  //    (the wizard's success path) and Mistral's fails (the curated-only fallback path) — so
  //    these dummy keys are never sent to a real provider.
  const userDId = await createUser(CONTRIBUTOR_D);
  const orgD = await insertOne("organizations", { name: ORG_D_NAME });
  await insertRows("memberships", { org_id: orgD.id, user_id: userDId, role: "admin" });

  for (const [provider, secret] of [
    ["openai", "sk-e2e-team-d-openai-key"],
    ["mistral", "e2eTeamDMistralKey00"],
  ]) {
    const { error: keyDError } = await supabase.rpc("set_provider_key", {
      p_org_id: orgD.id,
      p_provider: provider,
      p_secret: secret,
      p_last4: secret.slice(-4),
      p_created_by: userDId,
    });
    if (keyDError) abort(`seeding Team D ${provider} key failed: ${keyDError.message}`);
  }

  const RUBRIC_D_CRITERIA = [
    { name: "Answer quality", weight: 0.6, steps: ["Is the answer correct and complete?"] },
    { name: "Tone", weight: 0.4, steps: ["Is the tone friendly and professional?"] },
  ];
  const rubricD = await insertOne("rubrics", {
    created_by: userDId,
    org_id: orgD.id,
    name: "Umbrella reply quality (seed)",
    scenario_description: "A support reply drafted by the Umbrella agent.",
    expected_outcome: "The reply answers the question accurately in a friendly tone.",
    evaluation_mode: "prompt_response",
    grounding_context: null,
    criteria: RUBRIC_D_CRITERIA,
  });

  await insertOne("connections", {
    org_id: orgD.id,
    created_by: userDId,
    name: "Umbrella agent (seed)",
    kind: "agent",
    provider: "custom",
    endpoint: AGENT_ENDPOINT,
    auth_header: null,
    auth_secret_id: null,
    request_template: { input: "{{user_input}}", system: "{{prompt:system}}", style: "{{prompt:style}}" },
    response_path: "output",
    optimizable_prompts: MODULES,
  });

  await insertRows("customers", {
    org_id: orgD.id,
    stripe_customer_id: `cus_seed_${orgD.id}`,
    stripe_subscription_id: `sub_seed_${orgD.id}`,
    status: "active",
    stripe_price_id: builderPrice,
    current_period_start: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    current_period_end: new Date(Date.now() + 25 * 86_400_000).toISOString(),
    mirror_event_at: new Date().toISOString(),
    email: CONTRIBUTOR_D.email,
  });

  // Summary.
  const runCount = runIdsByRubric.reduce((n, list) => n + list.length, 0);
  console.log("\n✓ Seed complete\n");
  console.log(`  Team A:        ${ORG_NAME}`);
  console.log(`    Admin:       ${CONTRIBUTOR_A.email} / ${CONTRIBUTOR_A.password}`);
  console.log(`    Readonly:    ${READONLY_A.email} / ${READONLY_A.password}`);
  console.log(`  Team B:        ${ORG_B_NAME}`);
  console.log(`    Admin:       ${CONTRIBUTOR_B.email} / ${CONTRIBUTOR_B.password}`);
  console.log(`    Rubric id:   ${rubricB.id}  (cross-Team isolation target)`);
  console.log(`  Team C:        ${ORG_C_NAME} (Builder via seeded mirror row)`);
  console.log(`    Admin:       ${CONTRIBUTOR_C.email} / ${CONTRIBUTOR_C.password}`);
  console.log(`    Rubric:      ${rubricC.id}`);
  console.log(`    Dataset:     Initech traffic logs (seed) → ${DATASET_ENDPOINT} (#82 intake)`);
  console.log(`    Eval runs:   ${teamCRuns.length} completed (8-row + 3-row, "From an Eval Run" intake, #83)`);
  console.log(`  Team D:        ${ORG_D_NAME} (Builder + BYO OpenAI/Mistral keys, #485)`);
  console.log(`    Admin:       ${CONTRIBUTOR_D.email} / ${CONTRIBUTOR_D.password}`);
  console.log(`    Rubric:      ${rubricD.id}`);
  console.log(`  Rubrics:       ${RUBRICS.length} (Team A) + 1 (Team B)`);
  console.log(`  Eval runs:     ${runCount} (Team A, rising trend) + 1 (Team B)`);
  console.log(`  Schedule:      1 (agent) with ${scheduleRunIds.length} runs in history`);
  console.log(
    `  Optimization:  1 completed run, lift ${optOverall} → ${winnerOverall} (best candidate)`
  );
  console.log("");
}

seed().catch((err) => {
  console.error(`\n✗ Seed failed: ${err.message}\n`);
  process.exit(1);
});
