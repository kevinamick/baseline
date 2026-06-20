import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getAuthContext } from "@/lib/auth/context";
import { tenantDb } from "@/lib/supabase/tenant-db";
import { NavBar } from "@/app/_components/nav-bar";
import { ConnectionsList, type EditableConnection } from "./_components/connections-list";

// The team's Connections, with the Modules edit surface for agent rows (#119). Until now
// Connections only existed inside the Schedules/Optimizations wizards — this page is the
// place an existing agent Connection's optimizable Modules can be added or edited.
export default async function ConnectionsSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Settings.connections" });

  const ctx = await getAuthContext();
  const { userId, orgId, canWrite } = ctx;
  // proxy.ts protects the route; this defensive fallback matches the account settings page.
  if (!userId) redirect("/sign-in");
  // Signed in but no team yet — onboard before any org-scoped surface.
  if (!orgId) redirect("/onboarding");

  const { data } = await tenantDb(ctx)
    .from("connections")
    .select("id", "name", "kind", "provider", "endpoint", "request_template", "optimizable_prompts")
    .order("created_at", { ascending: false });

  const connections: EditableConnection[] = (data ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind as "agent" | "dataset",
    provider: c.provider,
    endpoint: c.endpoint,
    // The stored jsonb template, pretty-printed back to the string the editor works on.
    // A null template seeds "{}" so the editor is self-recovering: "+ Add Module" can
    // inject a ref and Save's JSON check passes without hand-writing JSON first.
    requestTemplate: c.request_template ? JSON.stringify(c.request_template, null, 2) : "{}",
    modules: Array.isArray(c.optimizable_prompts)
      ? (c.optimizable_prompts as { name?: unknown; seed?: unknown }[])
          .map((m) => ({ name: String(m?.name ?? ""), seed: String(m?.seed ?? "") }))
          .filter((m) => m.name)
      : [],
  }));

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <NavBar />
      <main className="mx-auto w-full max-w-2xl flex-1 p-6">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">{t("title")}</h1>
        <p className="mt-1 text-sm text-fg-2">{t("subtitle")}</p>
        <ConnectionsList connections={connections} canWrite={canWrite} />
      </main>
    </div>
  );
}
