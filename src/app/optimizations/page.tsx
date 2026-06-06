import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { NavBar } from "@/app/_components/nav-bar";
import { listOptimizationRuns } from "@/app/actions/optimizations";
import { OptimizationsLayout } from "./_components/optimizations-layout";

export default async function OptimizationsPage() {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId) return null;
  // Signed in but no team yet — onboard before any org-scoped surface.
  if (!orgId) redirect("/onboarding");

  const runs = await listOptimizationRuns();

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-paper">
      <NavBar />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 pb-6">
        <OptimizationsLayout runs={runs} canWrite={canWrite} />
      </div>
    </div>
  );
}
