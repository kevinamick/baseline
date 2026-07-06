import "server-only";
// Seed an Optimization Run's frozen Instance set from an existing Eval Run's rows (#83) — a
// further intake source alongside the wizard's manual/CSV/JSON rows and the dataset-Connection
// snapshot (#82). Unlike the dataset snapshot, this never leaves Postgres: eval_run_rows are
// already-stored rows, so there's no adapter fetch, no SSRF surface, and no timeout to race —
// just an org-scoped read.
//
// eval_runs/eval_run_rows carry no own org_id (class-B, #207): a Team's ownership is verified
// through the row's rubric, mirroring eval-runs.ts's other reads (getRunCriteriaBreakdown,
// getEvalRunDetails) and rubrics.ts's parentScoped pre-delete lookup. A foreign or unknown
// eval_run_id resolves to zero rows here — the SAME "not found" outcome as a real typo, so
// neither leaks which is which.
import { supabaseAdmin } from "@/lib/supabase/admin";
import { MAX_OPTIMIZATION_INSTANCES } from "@/lib/validation/schemas";

// An Instance has no agent_output — it's a frozen INPUT the run scores a newly-generated
// Candidate's output against, never a historical output — so eval_run_rows' agent_output
// column is dropped on the way in. Mirrors dataset-snapshot.ts's ResolvedOptimizationInstance
// shape exactly so the action's post-resolution path never reshapes by source.
export interface ResolvedOptimizationInstance {
  userInput: string;
  expectedOutput: string | null;
  retrievalContext: string | null;
}

export type EvalRunInstancesResult =
  | { instances: ResolvedOptimizationInstance[] }
  | { error: "not_found" | "empty" };

// Resolve an Eval Run's rows into the Instance shape, ordered by row_index and capped at
// MAX_OPTIMIZATION_INSTANCES (a larger Eval Run simply takes its first 50 rows). `orgId` is a
// trusted param, verified by the caller's auth gate — mirrors the orgId-param convention used by
// billing/*/connections/create.ts rather than threading a full AuthContext through for a single
// two-query read.
export async function resolveEvalRunInstances(
  orgId: string,
  evalRunId: string
): Promise<EvalRunInstancesResult> {
  const { data: run, error: runErr } = await supabaseAdmin
    .from("eval_runs")
    .select("id, rubrics!inner(org_id)")
    .eq("id", evalRunId)
    .eq("rubrics.org_id", orgId)
    .is("deleted_at", null) // a soft-deleted run can't seed a new one either (#187)
    .maybeSingle();
  if (runErr) throw runErr;
  if (!run) return { error: "not_found" };

  const { data: rows, error: rowsErr } = await supabaseAdmin
    .from("eval_run_rows")
    .select("user_input, expected_output, retrieval_context")
    .eq("eval_run_id", evalRunId)
    .order("row_index", { ascending: true })
    .limit(MAX_OPTIMIZATION_INSTANCES);
  if (rowsErr) throw rowsErr;
  if (!rows || rows.length === 0) return { error: "empty" };

  return {
    instances: rows.map((r) => ({
      userInput: r.user_input as string,
      expectedOutput: (r.expected_output as string | null) ?? null,
      retrievalContext: (r.retrieval_context as string | null) ?? null,
    })),
  };
}
