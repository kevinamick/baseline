"use server";

import { revalidatePath } from "next/cache";
import { requireContributor } from "@/lib/auth/require-contributor";
import { track } from "@/lib/analytics/server";
import { isLlmProvider } from "@/lib/llm/providers";
import { upsertProviderKey, deleteProviderKeyRow } from "@/lib/llm/keys";
import { localizeError } from "@/lib/i18n/errors";

// Manage a Team's BYO LLM provider keys (#184). Contributor-gated and
// org-scoped; the key value is write-only — these actions return only the
// masked last4, never the key. RLS denies anon/authenticated entirely; all
// access is via the service-role client scoped by the caller's org here.

export async function saveProviderKey(input: {
  provider: string;
  key: string;
}): Promise<{ last4: string | null } | { error: string }> {
  const gate = await requireContributor("manageProviderKeys");
  if ("error" in gate) return gate;
  const { userId, orgId } = gate;
  if (!isLlmProvider(input.provider)) {
    return { error: await localizeError("providerKeys", "unknownProvider") };
  }

  const key = (input.key ?? "").trim();
  if (!key) return { error: await localizeError("providerKeys", "enterKey") };

  const result = await upsertProviderKey(orgId, userId, input.provider, key);
  if ("error" in result) return result;

  await track(
    { name: "provider_key.saved", props: { team_id: orgId, provider: input.provider } },
    { userId }
  );
  revalidatePath("/settings/team");
  return { last4: result.last4 };
}

export async function deleteProviderKey(input: {
  provider: string;
}): Promise<{ ok: true } | { error: string }> {
  const gate = await requireContributor("manageProviderKeys");
  if ("error" in gate) return gate;
  const { userId, orgId } = gate;
  if (!isLlmProvider(input.provider)) {
    return { error: await localizeError("providerKeys", "unknownProvider") };
  }

  const result = await deleteProviderKeyRow(orgId, input.provider);
  if (result.error) return { error: result.error };

  await track(
    { name: "provider_key.removed", props: { team_id: orgId, provider: input.provider } },
    { userId }
  );
  revalidatePath("/settings/team");
  return { ok: true };
}
