import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NavBar } from "@/app/_components/nav-bar";
import { listOptimizationRuns } from "@/app/actions/optimizations";
import { OptimizationsLayout } from "./_components/optimizations-layout";
import type { RubricSummary } from "@/types/rubric";
import type { OptimizableConnection } from "@/types/optimization";

export default async function OptimizationsPage() {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId) return null;
  // Signed in but no team yet — onboard before any org-scoped surface.
  if (!orgId) redirect("/onboarding");

  // Runs for the list, plus the two inputs the start wizard needs: the team's rubrics, and the
  // agent Connections that declare ≥1 Module (only those have a {{prompt:*}} to optimize).
  const [runs, { data: rubrics }, { data: agentConnections }] = await Promise.all([
    listOptimizationRuns(),
    supabaseAdmin
      .from("rubrics")
      .select("id, name, evaluation_mode, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("connections")
      .select("id, name, optimizable_prompts")
      .eq("org_id", orgId)
      .eq("kind", "agent")
      .order("created_at", { ascending: false }),
  ]);

  const connections: OptimizableConnection[] = (agentConnections ?? [])
    .map((c) => ({
      id: c.id as string,
      name: c.name as string,
      modules: Array.isArray(c.optimizable_prompts)
        ? (c.optimizable_prompts as { name?: unknown }[])
            .map((m) => String(m?.name ?? ""))
            .filter(Boolean)
        : [],
    }))
    .filter((c) => c.modules.length > 0);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-paper">
      <NavBar />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 pb-6">
        <OptimizationsLayout
          runs={runs}
          rubrics={(rubrics ?? []) as RubricSummary[]}
          connections={connections}
          canWrite={canWrite}
        />
      </div>
    </div>
  );
}
