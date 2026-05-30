import { auth, clerkClient } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NavBar } from "@/app/_components/nav-bar";
import { DashboardClient } from "./_components/dashboard-client";
import {
  DAY_MS,
  nowMs,
  toneFor,
  type DashCriterion,
  type DashRubric,
  type DashRun,
  type DashboardData,
} from "./_lib/dashboard-data";
import type { Criterion, EvaluationMode } from "@/types/rubric";
import type { EvalRunStatus } from "@/types/eval-run";

export default async function DashboardPage() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return null;

  // Only Contributors (org admins) may create/run evals — mirrors the guard in
  // createEvalRun. Readonly Members get a view-only dashboard with no Run action.
  const canWrite = orgRole === "org:admin";

  // Team name on the server so the heading is correct on first paint
  // (useOrganization() is undefined during the initial client load).
  const client = await clerkClient();
  const org = await client.organizations
    .getOrganization({ organizationId: orgId })
    .catch(() => null);
  const teamName = org?.name ?? "your team";

  const now = nowMs();
  const windowStart = new Date(now - 90 * DAY_MS).toISOString();

  // Rubrics (with criteria definitions) for the team.
  const { data: rubricRows } = await supabaseAdmin
    .from("rubrics")
    .select("id, name, evaluation_mode, criteria, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });

  // All runs in the widest window — org-scoped via the rubric join.
  const { data: runRows } = await supabaseAdmin
    .from("eval_runs")
    .select("id, rubric_id, status, overall_score, created_at, rubrics!inner(org_id)")
    .eq("rubrics.org_id", orgId)
    .gte("created_at", windowStart)
    .order("created_at", { ascending: true });

  // Per-rubric sequential run numbers + the serializable run list.
  const runSeq = new Map<string, number>();
  const runs: DashRun[] = (runRows ?? []).map((r) => {
    const next = (runSeq.get(r.rubric_id) ?? 0) + 1;
    runSeq.set(r.rubric_id, next);
    return {
      id: r.id,
      rubricId: r.rubric_id,
      runNo: next,
      t: new Date(r.created_at).getTime(),
      score: r.overall_score != null ? Number(r.overall_score) : null,
      status: r.status as EvalRunStatus,
    };
  });

  // Latest completed, scored run per rubric — its criterion results feed the
  // focus card's per-criterion bars.
  const latestScoredRun = new Map<string, string>();
  for (const run of runs) {
    if (run.status === "completed" && run.score != null) {
      latestScoredRun.set(run.rubricId, run.id); // runs are ascending → last wins
    }
  }
  const latestRunIds = [...latestScoredRun.values()];

  const { data: resultRows } = latestRunIds.length
    ? await supabaseAdmin
        .from("eval_run_results")
        .select("eval_run_id, criterion_name, score")
        .in("eval_run_id", latestRunIds)
    : { data: [] };

  // Average each criterion's score across the run's rows, keyed by run id.
  const critAgg = new Map<string, Map<string, { sum: number; n: number }>>();
  for (const row of resultRows ?? []) {
    const byCrit = critAgg.get(row.eval_run_id) ?? new Map();
    const cur = byCrit.get(row.criterion_name) ?? { sum: 0, n: 0 };
    cur.sum += Number(row.score);
    cur.n += 1;
    byCrit.set(row.criterion_name, cur);
    critAgg.set(row.eval_run_id, byCrit);
  }

  const rubrics: DashRubric[] = (rubricRows ?? []).map((r, i) => {
    const runId = latestScoredRun.get(r.id);
    const byCrit = runId ? critAgg.get(runId) : undefined;
    const criteria: DashCriterion[] = ((r.criteria ?? []) as Criterion[]).map((c) => {
      const agg = byCrit?.get(c.name);
      return {
        name: c.name,
        weight: c.weight,
        score: agg ? agg.sum / agg.n : null,
      };
    });
    return {
      id: r.id,
      name: r.name,
      mode: r.evaluation_mode as EvaluationMode,
      createdAt: r.created_at,
      tone: toneFor(i),
      criteria,
    };
  });

  const data: DashboardData = { teamName, rubrics, runs, today: now };

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <NavBar />
      <DashboardClient data={data} canWrite={canWrite} />
    </div>
  );
}
