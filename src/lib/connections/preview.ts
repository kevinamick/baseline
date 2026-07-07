import "server-only";
// Inline "Test query" preview for dataset Connections (#39). This runs the *worker's* dataset
// adapter seam — getDatasetAdapter(provider), the same custom/posthog adapters worker.ts calls
// at each scheduled tick — once, from the Next server, against a bounded window/row cap with a
// short timeout, so the user can verify their HogQL aliases / field-map paths / auth before
// saving the schedule.
//
// Why run it here, in the app, rather than delegating to the worker:
//   - It reuses the adapter verbatim (no duplicated fetch logic) by importing across the
//     package boundary — the established pattern endpoint.ts (worker/src/ip-ranges) and
//     posthog-host.ts (worker/src/adapters/posthog-hosts) already use. The worker's runtime
//     is untouched: we add nothing to worker/ and change none of its behavior.
//   - The adapter calls safeFetch internally, so the preview inherits the worker's full SSRF
//     egress guard (private/reserved-address refusal, IP pinning, port allowlist, redirect
//     refusal, body cap) and the PostHog host allowlist. The preview is therefore NOT a new
//     server-side request-proxy surface.
//   - Secrets stay server-side: for a not-yet-saved Connection the typed API key / auth value
//     arrives in the server-action call and is used transiently to build the adapter's
//     authValue; it is never persisted and never returned to the browser.
import {
  type DatasetAdapter,
  type DatasetConnection,
  type DatasetRow,
  type FetchContext,
} from "../../../worker/src/adapters";
import { fetchDatasetRows } from "./dataset-fetch";
import {
  PREVIEW_MAX_ROWS,
  PREVIEW_TIMEOUT_MS,
  PREVIEW_WINDOW_MINUTES,
  type PreviewErrorCode,
  type PreviewResult,
  type PreviewRow,
} from "./preview-types";
import type { DatasetPreviewInput } from "@/lib/validation/schemas";

// Seams for tests: inject a fake adapter (so the mapping / bounds / error classification can be
// exercised without a network), a fixed clock (for a deterministic window), and tighter
// bounds. Production passes none and gets the real adapter + the shared PREVIEW_* constants.
export interface PreviewDeps {
  adapter?: DatasetAdapter;
  now?: () => Date;
  timeoutMs?: number;
  maxRows?: number;
  windowMinutes?: number;
}

// Build the DatasetConnection the adapter expects from the wizard's typed fields. This mirrors
// exactly what src/lib/connections/create.ts persists (provider, endpoint, auth_header,
// response_path, config) so the preview reads the source the same way a saved schedule will —
// the credential is just passed live instead of via a Vault secret id.
function buildConnection(
  spec: DatasetPreviewInput
): { connection: DatasetConnection; authValue: string | null } | { error: PreviewErrorCode; detail: string } {
  if (spec.type === "posthog_dataset") {
    return {
      connection: {
        id: "preview",
        kind: "dataset",
        provider: "posthog",
        endpoint: spec.host,
        auth_header: "Authorization",
        auth_secret_id: null,
        request_template: null,
        response_path: "results",
        config: { project_id: spec.projectId.trim(), hogql: spec.hogql },
      },
      // The stored secret IS the full header value; the user pastes the raw key (create.ts
      // prefixes it the same way).
      authValue: `Bearer ${spec.apiKey.trim()}`,
    };
  }

  // custom_dataset: the request template is a JSON object of query-param → templated value.
  // create.ts JSON.parses it at save time; do the same here and fail clearly if it's malformed.
  let requestTemplate: unknown;
  try {
    requestTemplate = JSON.parse(spec.requestTemplate);
  } catch {
    return { error: "config", detail: "Query template must be valid JSON" };
  }
  return {
    connection: {
      id: "preview",
      kind: "dataset",
      provider: "custom",
      endpoint: spec.endpoint,
      auth_header: spec.authHeader?.trim() || null,
      auth_secret_id: null,
      request_template: requestTemplate,
      response_path: spec.responsePath,
      config: {
        field_map: {
          user_input: spec.fieldMap.userInput,
          agent_output: spec.fieldMap.agentOutput,
        },
      },
    },
    authValue: spec.authValue?.trim() || null,
  };
}

function toPreviewRow(row: DatasetRow): PreviewRow {
  return {
    user_input: row.user_input,
    agent_output: row.agent_output,
    expected_output: row.expected_output,
    retrieval_context: row.retrieval_context,
  };
}

// Run the dataset query once against a bounded window/row cap with a timeout, returning the
// mapped sample rows or a categorized error. Pure orchestration over the worker adapter seam —
// it adds no fetch logic of its own.
export async function runDatasetPreview(
  spec: DatasetPreviewInput,
  deps: PreviewDeps = {}
): Promise<PreviewResult> {
  const maxRows = deps.maxRows ?? PREVIEW_MAX_ROWS;
  const windowMinutes = deps.windowMinutes ?? PREVIEW_WINDOW_MINUTES;
  const timeoutMs = deps.timeoutMs ?? PREVIEW_TIMEOUT_MS;
  const now = deps.now ?? (() => new Date());

  const built = buildConnection(spec);
  if ("error" in built) return built;
  const { connection, authValue } = built;

  const end = now();
  const start = new Date(end.getTime() - windowMinutes * 60_000);
  const ctx: FetchContext = {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    maxRows,
    authValue,
  };

  const fetched = await fetchDatasetRows(connection, ctx, { adapter: deps.adapter, timeoutMs });
  if ("error" in fetched) return fetched;

  // Cap defensively even though the adapter is asked for maxRows — a source that ignores the
  // limit must not flood the preview.
  const capped = fetched.rows.slice(0, maxRows).map(toPreviewRow);
  // Rows came back but nothing landed in the two required fields → the aliases / paths are
  // almost certainly wrong. Surface it alongside the (empty-looking) rows, not as an error.
  const nothingMapped =
    capped.length > 0 && capped.every((r) => !r.user_input && !r.agent_output);
  return nothingMapped ? { rows: capped, warning: "no_columns_mapped" } : { rows: capped };
}
