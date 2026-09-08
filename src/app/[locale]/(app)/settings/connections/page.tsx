import { getTranslations, setRequestLocale } from "next-intl/server";
import { getAuthContext } from "@/lib/auth/context";
import { tenantDb } from "@/lib/supabase/tenant-db";
import {
  ConnectionsList,
  type EditableConnection,
} from "./_components/connections-list";

// The team's Connections, with the Modules edit surface for agent rows (#119). Until now
// Connections only existed inside the Schedules/Optimizations wizards — this page is the
// place an existing agent Connection's optimizable Modules can be added or edited. The
// "Add connection" dialog (#353) also lets a new Connection be created here directly.
export default async function ConnectionsSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({
    locale,
    namespace: "Settings.connections",
  });

  const ctx = await getAuthContext();
  const { canWrite } = ctx;

  const [{ data, error: connectionsErr }] = await Promise.all([
    tenantDb(ctx)
      .from("connections")
      .select(
        "id",
        "name",
        "kind",
        "provider",
        "endpoint",
        "agent_kind",
        "target_model",
        "request_template",
        "optimizable_prompts",
      )
      .order("created_at", { ascending: false }),
  ]);
  if (connectionsErr) throw connectionsErr;

  // A Managed Agent runs on the Workspace's own provider key (ADR-0020): always available.
  const managedAllowed = true;

  const connections: EditableConnection[] = (data ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind as "agent" | "dataset",
    // "managed" Connections run on the managed LLM and edit a prompt, not a request template;
    // "external" agents (and datasets) keep the Modules editor (#294).
    agentKind: c.agent_kind === "managed" ? "managed" : "external",
    provider: c.provider,
    endpoint: c.endpoint,
    targetModel: c.target_model,
    // The stored jsonb template, pretty-printed back to the string the editor works on.
    // A null template seeds "{}" so the editor is self-recovering: "+ Add Module" can
    // inject a ref and Save's JSON check passes without hand-writing JSON first.
    requestTemplate: c.request_template
      ? JSON.stringify(c.request_template, null, 2)
      : "{}",
    modules: Array.isArray(c.optimizable_prompts)
      ? (c.optimizable_prompts as { name?: unknown; seed?: unknown }[])
          .map((m) => ({
            name: String(m?.name ?? ""),
            seed: String(m?.seed ?? ""),
          }))
          .filter((m) => m.name)
      : [],
  }));

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 p-6">
      <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
        {t("title")}
      </h1>
      <p className="mt-1 text-sm text-fg-2">{t("subtitle")}</p>
      <ConnectionsList
        connections={connections}
        canWrite={canWrite}
        managedAllowed={managedAllowed}
      />
    </main>
  );
}
