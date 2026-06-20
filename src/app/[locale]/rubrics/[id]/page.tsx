import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { notFound, redirect } from "next/navigation";
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
  const { userId, orgId } = await getAuthContext();
  if (!userId) return null;
  // Signed in but no team yet — onboard before any org-scoped surface.
  if (!orgId) redirect("/onboarding");

  const { data } = await supabaseAdmin
    .from("rubrics")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();

  if (!data) notFound();

  const rubric = data as Rubric;

  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-10 flex w-full items-center justify-between px-6 py-4">
        <Link
          href="/rubrics"
          className="inline-flex items-center gap-2 rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-card-warm"
        >
          ← Rubrics
        </Link>
        <span className="inline-flex items-center rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent-ink">
          {MODE_LABEL[rubric.evaluation_mode] ?? rubric.evaluation_mode}
        </span>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink">
            {rubric.name}
          </h1>
          <p className="mt-1.5 font-mono text-xs text-fg-2">
            Created {new Date(rubric.created_at).toLocaleDateString()}
          </p>
        </div>

        <Section title="Scenario description">
          <p className="whitespace-pre-wrap text-sm leading-normal text-fg-2">
            {rubric.scenario_description}
          </p>
        </Section>

        <Section title="Expected outcome">
          <p className="whitespace-pre-wrap text-sm leading-normal text-fg-2">
            {rubric.expected_outcome}
          </p>
        </Section>

        {rubric.grounding_context && (
          <Section title="Grounding context">
            <p className="whitespace-pre-wrap text-sm leading-normal text-fg-2">
              {rubric.grounding_context}
            </p>
          </Section>
        )}

        <Section title="Criteria">
          <div className="flex flex-col gap-3">
            {rubric.criteria.map((criterion, i) => (
              <div
                key={i}
                className="rounded-xl border border-hairline-cool bg-card p-5 shadow-card"
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-semibold text-ink">
                    {criterion.name}
                  </span>
                  <span className="inline-flex items-center rounded-full bg-accent-soft px-2.5 py-0.5 font-mono text-xs font-semibold tabular-nums text-accent-ink">
                    w {criterion.weight.toFixed(2)}
                  </span>
                </div>
                <ol className="flex list-none flex-col gap-1.5">
                  {criterion.steps.map((step, si) => (
                    <li key={si} className="flex gap-2.5 text-sm">
                      <span className="w-4 shrink-0 text-right font-mono text-xs text-fg-2">
                        {si + 1}.
                      </span>
                      <span className="text-fg-2">{step}</span>
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
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-2">
        {title}
      </h2>
      {children}
    </div>
  );
}
