import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { RubricsPanel } from "./_components/rubrics-panel";
import { RunsPanel } from "./_components/runs-panel";
import type { RubricSummary } from "@/types/rubric";

export default async function RubricsPage() {
  const { userId } = await auth();
  if (!userId) return null;

  const { data } = await supabaseAdmin
    .from("rubrics")
    .select("id, name, evaluation_mode, created_at")
    .eq("created_by", userId)
    .order("created_at", { ascending: false });

  const rubrics = (data ?? []) as RubricSummary[];

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-zinc-100 dark:bg-zinc-950 p-4 gap-3">
      <header className="px-6 py-5 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-sm shrink-0">
        <h1 className="text-xl font-semibold tracking-tight">Rubrics</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Scoring guidelines the judge uses to evaluate agent output
        </p>
      </header>
      <div className="flex flex-1 overflow-hidden gap-3 min-h-0">
        <RubricsPanel rubrics={rubrics} />
        <RunsPanel />
      </div>
    </div>
  );
}
