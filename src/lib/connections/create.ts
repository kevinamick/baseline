import "server-only";
import type { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { NewConnectionSchema } from "@/lib/validation/schemas";
import { validateTemplateModuleRefs } from "@/lib/optimization/prompt-refs";

type NewConnection = z.infer<typeof NewConnectionSchema>;
// `warning` is advisory: the row saved, but something looks like a mistake (e.g. a declared
// Module the request template never references). Callers may surface it; none must.
type Result = { connectionId: string; warning?: string } | { error: string };

// The columns persistConnection writes (shared across all connection types).
interface ConnectionFields {
  name: string;
  kind: "agent" | "dataset";
  provider: string;
  endpoint: string;
  auth_header: string | null;
  auth_secret_id: string | null;
  request_template: unknown;
  response_path: string;
  config: unknown;
  // Agent kind only; defaults to null in persistConnection for the dataset branches.
  optimizable_prompts?: unknown;
}

// Store a credential in Supabase Vault; returns the secret id (or null if no value).
async function createSecretIfPresent(
  orgId: string,
  name: string,
  value: string | null | undefined
): Promise<{ secretId: string | null } | { error: string }> {
  const trimmed = value?.trim();
  if (!trimmed) return { secretId: null };
  const { data, error } = await supabaseAdmin.rpc("create_connection_secret", {
    p_secret: trimmed,
    p_name: `conn:${orgId}:${name}:${Date.now()}`,
  });
  if (error || !data) {
    console.error("create_connection_secret failed", error);
    return { error: "Failed to store credential" };
  }
  return { secretId: data as string };
}

// Insert the connections row; if it fails after a secret was created, remove the secret
// so it isn't orphaned in Vault (no row exists yet for the delete-trigger to clean up).
async function persistConnection(
  orgId: string,
  userId: string,
  fields: ConnectionFields
): Promise<Result> {
  const { data: conn, error } = await supabaseAdmin
    .from("connections")
    // optimizable_prompts defaults to null; only the agent branch sets a value.
    .insert({ org_id: orgId, created_by: userId, optimizable_prompts: null, ...fields })
    .select("id")
    .single();

  if (error || !conn) {
    console.error("connections insert failed", error);
    if (fields.auth_secret_id) {
      await supabaseAdmin
        .rpc("delete_connection_secret", { p_secret_id: fields.auth_secret_id })
        .then(({ error: cleanupErr }) => {
          if (cleanupErr) console.error("orphaned secret cleanup failed", cleanupErr);
        });
    }
    return { error: "Failed to save connection" };
  }
  return { connectionId: conn.id };
}

// Shared connection-insert used by both createConnection and createSchedule (inline
// creation). Kept out of the "use server" action files so it isn't exposed as an action.
// Branches by connection type; the credential always lands in Vault (row keeps only the ref).
export async function insertConnection(
  orgId: string,
  userId: string,
  data: NewConnection
): Promise<Result> {
  switch (data.type) {
    case "agent": {
      let requestTemplate: unknown;
      try {
        requestTemplate = JSON.parse(data.requestTemplate);
      } catch {
        return { error: "Request template must be valid JSON" };
      }

      // Cross-field rule (#94): every {{prompt:X}} the template references must be a declared
      // Module (hard error); a declared-but-unreferenced Module is a soft warning. The rule
      // lives in validateTemplateModuleRefs (shared with the worker's invocation-time guard
      // and the #119 update path) so every save/execute boundary applies it identically.
      // Runs on the parsed template so it scans exactly what the renderer will.
      const checked = validateTemplateModuleRefs(
        requestTemplate,
        (data.optimizablePrompts ?? []).map((m) => m.name)
      );
      if ("error" in checked) return checked;
      const warning = checked.warning;

      const sec = await createSecretIfPresent(orgId, data.name, data.authValue);
      if ("error" in sec) return sec;
      const persisted = await persistConnection(orgId, userId, {
        name: data.name,
        kind: "agent",
        provider: "custom",
        endpoint: data.endpoint,
        // Only keep the header name when there's actually a secret to carry it.
        auth_header: sec.secretId ? data.authHeader?.trim() || null : null,
        auth_secret_id: sec.secretId,
        request_template: requestTemplate,
        response_path: data.responsePath,
        config: null,
        // Persist declared Modules (name + seed) as a jsonb array; null when none so the
        // common {{user_input}}-only agent stays a plain row.
        optimizable_prompts: data.optimizablePrompts?.length ? data.optimizablePrompts : null,
      });
      if ("error" in persisted || !warning) return persisted;
      return { ...persisted, warning };
    }

    case "custom_dataset": {
      let requestTemplate: unknown;
      try {
        requestTemplate = JSON.parse(data.requestTemplate);
      } catch {
        return { error: "Query template must be valid JSON" };
      }
      const sec = await createSecretIfPresent(orgId, data.name, data.authValue);
      if ("error" in sec) return sec;
      return persistConnection(orgId, userId, {
        name: data.name,
        kind: "dataset",
        provider: "custom",
        endpoint: data.endpoint,
        auth_header: sec.secretId ? data.authHeader?.trim() || null : null,
        auth_secret_id: sec.secretId,
        request_template: requestTemplate,
        response_path: data.responsePath,
        config: {
          field_map: {
            user_input: data.fieldMap.userInput,
            agent_output: data.fieldMap.agentOutput,
          },
        },
      });
    }

    case "posthog_dataset": {
      // The user pastes the raw personal API key; we store the full header value verbatim.
      const sec = await createSecretIfPresent(orgId, data.name, `Bearer ${data.apiKey.trim()}`);
      if ("error" in sec) return sec;
      return persistConnection(orgId, userId, {
        name: data.name,
        kind: "dataset",
        provider: "posthog",
        endpoint: data.host,
        auth_header: "Authorization",
        auth_secret_id: sec.secretId,
        request_template: null,
        response_path: "results",
        config: { project_id: data.projectId.trim(), hogql: data.hogql },
      });
    }
  }
}
