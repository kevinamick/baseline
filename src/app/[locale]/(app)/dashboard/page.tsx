import { getTranslations, setRequestLocale } from "next-intl/server";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tenantDb } from "@/lib/supabase/tenant-db";
import { getWorkspaceName } from "@/lib/auth/workspace";
import { log } from "@/lib/logging/server";
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
import { AUTO_FIT_RUNS } from "./_lib/range";
import type { Criterion, EvaluationMode } from "@/types/rubric";
import type { EvalRunStatus } from "@/types/eval-run";

// Row shape returned by the dashboard_runs RPC (the client is untyped).
interface DashboardRunRow {
  id: string;
  rubric_id: string;
  status: string;
  overall_score: number | string | null;
  created_at: string;
  run_no: number | string;
}

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Dashboard" });

  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  if (!userId) return null;
  // Signed in but no team yet — onboard before any org-scoped surface.

  // Only Contributors (org admins) may create/run evals — mirrors the guard in
  // createEvalRun. Readonly Members get a view-only dashboard with no Run action.

  const now = nowMs();
  const windowStart = new Date(now - 90 * DAY_MS).toISOString();

  // These all depend only on orgId, so fetch them in one round trip rather than
  // a serial waterfall (the Workspace name, the rubrics, the runs RPC). Only
  // eval_run_results below is dependent — it keys off the runs result — so it
  // stays sequential.
  //
  // teamName: the active org's name so the dashboard tracks team switches (#52),
  // neutral label only as a fallback.
  // rubricRows: rubrics with criteria definitions for the team.
  // runRows: runs for the chart and cards — the 90d window, plus each rubric's
  //   last N runs and latest scored run regardless of age, with true per-rubric
  //   run_no. See the dashboard_runs migration for the union rationale.
  const [
    teamName,
    { data: rubricRows, error: rubricsError },
    { data: runRows, error: runsError },
  ] = await Promise.all([
    getWorkspaceName(orgId, t("yourTeam")),
    tenantDb(ctx)
      .from("rubrics")
      .select("id", "name", "evaluation_mode", "criteria", "created_at")
      .order("created_at", { ascending: true }),
    supabaseAdmin.rpc("dashboard_runs", {
      p_org_id: orgId,
      p_window_start: windowStart,
      p_n: AUTO_FIT_RUNS,
    }),
  ]);
  if (rubricsError) throw new Error(`Failed to load rubrics: ${rubricsError.message}`);

  // Surface a fetch failure instead of rendering an empty dashboard that looks
  // identical to a genuinely empty org — e.g. if the migration hasn't been
  // applied to this environment yet (staging needs a manual db push).
  if (runsError) {
    await log.error("dashboard_runs failed", {
      event: "dashboard.runs_fetch_failed",
      org_id: orgId,
      error: runsError,
    });
    throw new Error(`Failed to load dashboard runs: ${runsError.message}`);
  }

  const runs: DashRun[] = ((runRows ?? []) as DashboardRunRow[]).map((r) => ({
    id: r.id,
    rubricId: r.rubric_id,
    runNo: Number(r.run_no),
    t: new Date(r.created_at).getTime(),
    score: r.overall_score != null ? Number(r.overall_score) : null,
    status: r.status as EvalRunStatus,
  }));

  // Latest completed, scored run per rubric — its criterion results feed the
  // focus card's per-criterion bars.
  const latestScoredRun = new Map<string, string>();
  for (const run of runs) {
    if (run.status === "completed" && run.score != null) {
      latestScoredRun.set(run.rubricId, run.id); // runs are ascending → last wins
    }
  }
  const latestRunIds = [...latestScoredRun.values()];

  const { data: resultRows, error: resultsError } = latestRunIds.length
    ? await supabaseAdmin
        .from("eval_run_results")
        .select("eval_run_id, criterion_name, score")
        .in("eval_run_id", latestRunIds)
    : { data: [], error: null };
  if (resultsError) throw new Error(`Failed to load criterion results: ${resultsError.message}`);

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
    // `criteria` is a Json column in the schema; the app stores Criterion[] in it.
    const criteria: DashCriterion[] = ((r.criteria ?? []) as unknown as Criterion[]).map(
      (c) => {
        const agg = byCrit?.get(c.name);
        return {
          name: c.name,
          weight: c.weight,
          score: agg ? agg.sum / agg.n : null,
        };
      },
    );
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
    // flex-1 fills the space below the persistent nav (so the gradient covers the
    // viewport when content is short) and grows with content to scroll the window.
    <div className="flex-1 bg-paper-gradient">
      <DashboardClient data={data} canWrite={canWrite} />
    </div>
  );
}
