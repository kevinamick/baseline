import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { notFound } from "next/navigation";
import Link from "next/link";
import type { Rubric } from "@/types/rubric";

const MODE_LABEL: Record<string, string> = {
  prompt_response: "Prompt / Response",
  conversational: "Conversational",
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function RubricPage({ params }: Props) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) return null;

  const { data } = await supabaseAdmin
    .from("rubrics")
    .select("*")
    .eq("id", id)
    .eq("created_by", userId)
    .maybeSingle();

  if (!data) notFound();

  const rubric = data as Rubric;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="sticky top-0 z-10 w-full flex items-center justify-between px-8 py-4 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <Link
          href="/rubrics"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
        >
          ← Rubrics
        </Link>
        <span className="text-xs text-zinc-400">
          {MODE_LABEL[rubric.evaluation_mode] ?? rubric.evaluation_mode}
        </span>
      </header>

      <main className="max-w-2xl mx-auto px-8 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">
            {rubric.name}
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            Created {new Date(rubric.created_at).toLocaleDateString()}
          </p>
        </div>

        <Section title="Scenario description">
          <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
            {rubric.scenario_description}
          </p>
        </Section>

        <Section title="Expected outcome">
          <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
            {rubric.expected_outcome}
          </p>
        </Section>

        {rubric.grounding_context && (
          <Section title="Grounding context">
            <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
              {rubric.grounding_context}
            </p>
          </Section>
        )}

        <Section title="Criteria">
          <div className="flex flex-col gap-3">
            {rubric.criteria.map((criterion, i) => (
              <div
                key={i}
                className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 bg-white dark:bg-zinc-900"
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium">{criterion.name}</span>
                  <span className="text-xs text-zinc-400">
                    {(criterion.weight * 100).toFixed(0)}% weight
                  </span>
                </div>
                <ol className="space-y-1 list-none">
                  {criterion.steps.map((step, si) => (
                    <li key={si} className="flex gap-2 text-sm">
                      <span className="text-zinc-400 shrink-0 w-4 text-right">
                        {si + 1}.
                      </span>
                      <span className="text-zinc-600 dark:text-zinc-400">
                        {step}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </Section>
      </main>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-8">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-3">
        {title}
      </h2>
      {children}
    </div>
  );
}
