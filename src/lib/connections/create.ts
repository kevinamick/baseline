import "server-only";
import type { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { NewConnectionSchema } from "@/lib/validation/schemas";

// Shared connection-insert used by both createConnection and createSchedule (inline
// creation). Kept out of the "use server" action files so it isn't exposed as an action.
// Stores the credential in Supabase Vault; the row keeps only auth_secret_id.
export async function insertConnection(
  orgId: string,
  userId: string,
  data: z.infer<typeof NewConnectionSchema>
): Promise<{ connectionId: string } | { error: string }> {
  let requestTemplate: unknown;
  try {
    requestTemplate = JSON.parse(data.requestTemplate);
  } catch {
    return { error: "Request template must be valid JSON" };
  }

  let authSecretId: string | null = null;
  const authValue = data.authValue?.trim();
  if (authValue) {
    const { data: secretId, error: secretErr } = await supabaseAdmin.rpc(
      "create_connection_secret",
      { p_secret: authValue, p_name: `conn:${orgId}:${data.name}:${Date.now()}` }
    );
    if (secretErr || !secretId) {
      console.error("create_connection_secret failed", secretErr);
      return { error: "Failed to store credential" };
    }
    authSecretId = secretId as string;
  }

  const { data: conn, error } = await supabaseAdmin
    .from("connections")
    .insert({
      org_id: orgId,
      created_by: userId,
      name: data.name,
      kind: "agent",
      provider: "custom",
      endpoint: data.endpoint,
      // Only keep the header name when there's actually a secret to carry — avoids
      // storing an orphan header (e.g. the pre-filled "Authorization") with no value.
      auth_header: authSecretId ? data.authHeader?.trim() || null : null,
      auth_secret_id: authSecretId,
      request_template: requestTemplate,
      response_path: data.responsePath,
    })
    .select("id")
    .single();

  if (error || !conn) {
    console.error("connections insert failed", error);
    return { error: "Failed to save connection" };
  }

  return { connectionId: conn.id };
}
