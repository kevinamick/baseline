import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { getBillingState } from "@/lib/billing/state";
import { PLANS } from "@/lib/billing/plans";
import { listProviderKeys } from "@/lib/llm/keys";
import {
  LLM_PROVIDERS,
  PROVIDER_LABELS,
  isRuntimeReady,
} from "@/lib/llm/providers";
import { NavBar } from "@/app/_components/nav-bar";
import { ProviderKeysList, type ProviderKeyRow } from "./_components/provider-keys-list";

// BYO provider keys (#184). A Team stores one LLM key per provider in Supabase
// Vault; judge and Reflection calls resolve the Team's key at run time. Free
// Teams run on BYO only (no managed fallback), so this is where they add the key
// their runs require. Key values are write-only — only the masked last4 ever
// reaches this page.
export default async function ApiKeysSettingsPage() {
  const { userId, orgId, canWrite } = await getAuthContext();
  // proxy.ts protects the route; this defensive fallback matches the other settings pages.
  if (!userId) redirect("/sign-in");
  if (!orgId) redirect("/onboarding");

  const [keys, billing] = await Promise.all([
    listProviderKeys(orgId),
    getBillingState(orgId),
  ]);

  // Free Teams have no managed-key fallback (managedMarkupPct is null), so a key
  // is required to run. Paid Teams can run on the managed platform key.
  const byoRequired = PLANS[billing.plan].managedMarkupPct == null;

  const rows: ProviderKeyRow[] = LLM_PROVIDERS.map((provider) => {
    const existing = keys.find((k) => k.provider === provider);
    return {
      provider,
      label: PROVIDER_LABELS[provider],
      runtimeReady: isRuntimeReady(provider),
      last4: existing?.last4 ?? null,
      hasKey: Boolean(existing),
      updatedAt: existing?.updatedAt ?? null,
    };
  });

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <NavBar />
      <main className="mx-auto w-full max-w-2xl flex-1 p-6">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">API Keys</h1>
        <p className="mt-1 text-sm text-fg-2">
          Your team&apos;s LLM provider keys. Baseline uses them for judging and prompt
          optimization. Keys are stored encrypted and never shown again after you save them.
        </p>

        {byoRequired && (
          <p className="mt-4 rounded-2xl border border-hairline-cool bg-card-warm p-4 text-sm text-fg-2">
            Your team is on the <span className="font-medium text-ink">Free</span> plan, which
            runs on your own provider key — add one below to run evaluations.
          </p>
        )}

        <ProviderKeysList rows={rows} canWrite={canWrite} />
      </main>
    </div>
  );
}
