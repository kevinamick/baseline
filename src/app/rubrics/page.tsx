import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { RubricsLayout } from "./_components/rubrics-layout";
import type { RubricSummary } from "@/types/rubric";

export default async function RubricsPage() {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) return null;

  const { data } = await supabaseAdmin
    .from("rubrics")
    .select("id, name, evaluation_mode, created_at")
    .eq("org_id", orgId)
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
      <RubricsLayout rubrics={rubrics} />
    </div>
  );
}
