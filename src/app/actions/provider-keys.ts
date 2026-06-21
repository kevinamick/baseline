"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/context";
import { track } from "@/lib/analytics/server";
import { isLlmProvider } from "@/lib/llm/providers";
import { upsertProviderKey, deleteProviderKeyRow } from "@/lib/llm/keys";

// Manage a Team's BYO LLM provider keys (#184). Contributor-gated and
// org-scoped; the key value is write-only — these actions return only the
// masked last4, never the key. RLS denies anon/authenticated entirely; all
// access is via the service-role client scoped by the caller's org here.

export async function saveProviderKey(input: {
  provider: string;
  key: string;
}): Promise<{ last4: string | null } | { error: string }> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (!canWrite) return { error: "Only contributors can manage provider keys" };
  if (!isLlmProvider(input.provider)) return { error: "Unknown provider" };

  const key = (input.key ?? "").trim();
  if (!key) return { error: "Enter a provider key" };

  const result = await upsertProviderKey(orgId, userId, input.provider, key);
  if ("error" in result) return result;

  await track(
    { name: "provider_key.saved", props: { team_id: orgId, provider: input.provider } },
    { userId }
  );
  revalidatePath("/settings/api-keys");
  return { last4: result.last4 };
}

export async function deleteProviderKey(input: {
  provider: string;
}): Promise<{ ok: true } | { error: string }> {
  const { userId, orgId, canWrite } = await getAuthContext();
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (!canWrite) return { error: "Only contributors can manage provider keys" };
  if (!isLlmProvider(input.provider)) return { error: "Unknown provider" };

  const result = await deleteProviderKeyRow(orgId, input.provider);
  if (result.error) return { error: result.error };

  await track(
    { name: "provider_key.removed", props: { team_id: orgId, provider: input.provider } },
    { userId }
  );
  revalidatePath("/settings/api-keys");
  return { ok: true };
}
