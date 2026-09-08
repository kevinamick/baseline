import { getTranslations, setRequestLocale } from "next-intl/server";
import { getAuthContext } from "@/lib/auth/context";
import { getWorkspaceName } from "@/lib/auth/workspace";
import { getBillingState } from "@/lib/billing/state";
import { PLANS } from "@/lib/billing/plans";
import { getProviderKeyRows } from "@/lib/llm/keys";
import { ProviderKeysList } from "@/app/_components/provider-keys-list";

/**
 * The Workspace's provider keys (ADR-0020). Every key here is a BYO key stored
 * in Vault; the worker's environment keys are the fallback when a provider has
 * no row. There is no membership to manage — the Local Workspace has one
 * Contributor, and that is whoever reaches the app.
 */
export default async function TeamSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Settings.team" });

  const { canWrite, orgId } = await getAuthContext();

  const [workspaceName, providerKeyRows, billing] = await Promise.all([
    getWorkspaceName(orgId),
    getProviderKeyRows(orgId),
    getBillingState(orgId),
  ]);

  // Free Teams have no managed-key fallback, so a provider key is required to run.
  const byoRequired = PLANS[billing.plan].managedMarkupPct == null;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 p-6">
      <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
        {workspaceName}
      </h1>
      <p className="mt-1 text-sm text-fg-2">{t("subtitle")}</p>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-ink">
          {t("providerKeysHeading")}
        </h2>
        <p className="mt-1 text-sm text-fg-2">{t("providerKeysBlurb")}</p>
        {byoRequired && (
          <p className="mt-3 rounded-2xl border border-hairline-cool bg-card-warm p-4 text-sm text-fg-2">
            {t.rich("byoRequired", {
              strong: (chunks) => (
                <span className="font-medium text-ink">{chunks}</span>
              ),
            })}
          </p>
        )}
        <ProviderKeysList rows={providerKeyRows} canWrite={canWrite} />
      </section>
    </main>
  );
}
