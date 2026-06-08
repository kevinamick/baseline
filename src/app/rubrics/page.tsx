import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { RubricsLayout } from "./_components/rubrics-layout";
import { RubricsHeader } from "./_components/rubrics-header";
import { NavBar } from "@/app/_components/nav-bar";
import type { RubricSummary } from "@/types/rubric";

export default async function RubricsPage() {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId) return null;
  // Signed in but no team yet — onboard before any org-scoped surface.
  if (!orgId) redirect("/onboarding");

  // Contributors (org admins) can create/edit/delete rubrics and run evals;
  // Readonly Members get a view-only surface. Mirrors the server-side guards in
  // createRubric/updateRubric/deleteRubric and createEvalRun.

  const { data } = await supabaseAdmin
    .from("rubrics")
    .select("id, name, evaluation_mode, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  const rubrics = (data ?? []) as RubricSummary[];

  // Team-wide KPI aggregates — join eval_runs through rubrics for org scoping.
  const { data: runRows } = await supabaseAdmin
    .from("eval_runs")
    .select("overall_score, status, rubrics!inner(org_id)")
    .eq("rubrics.org_id", orgId);

  const runCount = runRows?.length ?? 0;
  const scored = (runRows ?? [])
    .filter((r) => r.status === "completed" && r.overall_score != null)
    .map((r) => Number(r.overall_score));
  const avgScore =
    scored.length > 0
      ? scored.reduce((sum, s) => sum + s, 0) / scored.length
      : null;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-paper">
      <NavBar />
      <div className="mx-auto flex min-h-0 w-full max-w-[1360px] flex-1 flex-col gap-4 overflow-hidden px-6 pb-6">
        <RubricsHeader
          rubricCount={rubrics.length}
          runCount={runCount}
          avgScore={avgScore}
        />
        <RubricsLayout rubrics={rubrics} canWrite={canWrite} />
      </div>
    </div>
  );
}
