import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { Rubric } from "@/types/rubric";

interface Props {
  params: Promise<{ id: string; locale: string }>;
}

export default async function RubricPage({ params }: Props) {
  const { id, locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Rubrics" });

  const { userId, orgId } = await getAuthContext();
  if (!userId) return null;
  // Signed in but no team yet — onboard before any org-scoped surface.
  if (!orgId) redirect("/onboarding");

  const { data, error: rubricErr } = await supabaseAdmin
    // eslint-disable-next-line no-restricted-syntax -- org-scoped by the explicit .eq("org_id", orgId); pending tenantDb migration (#207)
    .from("rubrics")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (rubricErr) throw rubricErr;

  if (!data) notFound();

  const rubric = data as Rubric;

  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-10 flex w-full items-center justify-between px-6 py-4">
        <Link
          href="/rubrics"
          className="inline-flex items-center gap-2 rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-card-warm"
        >
          {t("detail.back")}
        </Link>
        <span className="inline-flex items-center rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent-ink">
          {rubric.evaluation_mode === "prompt_response" ||
          rubric.evaluation_mode === "conversational"
            ? t(`mode.${rubric.evaluation_mode}`)
            : rubric.evaluation_mode}
        </span>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink">
            {rubric.name}
          </h1>
          <p className="mt-1.5 font-mono text-xs text-fg-2">
            {t("detail.created", {
              date: new Intl.DateTimeFormat(locale).format(
                new Date(rubric.created_at)
              ),
            })}
          </p>
        </div>

        <Section title={t("detail.scenario")}>
          <p className="whitespace-pre-wrap text-sm leading-normal text-fg-2">
            {rubric.scenario_description}
          </p>
        </Section>

        <Section title={t("detail.expectedOutcome")}>
          <p className="whitespace-pre-wrap text-sm leading-normal text-fg-2">
            {rubric.expected_outcome}
          </p>
        </Section>

        {rubric.grounding_context && (
          <Section title={t("detail.groundingContext")}>
            <p className="whitespace-pre-wrap text-sm leading-normal text-fg-2">
              {rubric.grounding_context}
            </p>
          </Section>
        )}

        <Section title={t("detail.criteria")}>
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
                    {t("detail.weight", { weight: criterion.weight.toFixed(2) })}
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
