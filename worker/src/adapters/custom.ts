// Custom dataset adapter: GET the customer's log/trace API with the time window and row
// cap rendered into query-string params, then map each returned row object to our fields
// via a configured field_map. The mirror image of the custom agent adapter.

import { renderTemplate, getByPath, stringifyValue } from "../template.js";
import { safeFetch } from "../safe-fetch.js";
import type { DatasetAdapter, DatasetConnection, DatasetRow, FetchContext } from "./types.js";

interface FieldMap {
  user_input?: string;
  agent_output?: string;
}

// Read a field by its configured path. An empty/absent path means "unmapped" → null,
// NOT the whole row: getByPath("") returns the root object, which would otherwise be
// stringified into the field (e.g. user_input becoming the entire row JSON).
function readField(row: unknown, path: string | undefined): string | null {
  if (!path?.trim()) return null;
  return stringifyValue(getByPath(row, path));
}

function mapRow(row: unknown, fieldMap: FieldMap): DatasetRow {
  return {
    user_input: readField(row, fieldMap.user_input) ?? "",
    agent_output: readField(row, fieldMap.agent_output) ?? "",
    expected_output: null,
    retrieval_context: null,
  };
}

export const customDatasetAdapter: DatasetAdapter = async (
  connection: DatasetConnection,
  ctx: FetchContext
): Promise<DatasetRow[]> => {
  const vars = {
    window_start: ctx.windowStart,
    window_end: ctx.windowEnd,
    max_rows: String(ctx.maxRows),
  };

  // request_template is a flat object of query-param → templated value.
  const url = new URL(connection.endpoint);
  const template = connection.request_template;
  if (template && typeof template === "object" && !Array.isArray(template)) {
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) {
      const rendered = renderTemplate(value, vars);
      url.searchParams.set(key, typeof rendered === "string" ? rendered : JSON.stringify(rendered));
    }
  }

  const headers: Record<string, string> = {};
  if (connection.auth_header && ctx.authValue) {
    headers[connection.auth_header] = ctx.authValue;
  }

  // Outbound header allowlist (#222): this GET sends only the Connection's configured auth
  // header (no body, so no Content-Type). safeFetch drops everything else, so no internal /
  // telemetry header can leak to the tenant endpoint.
  const allowedHeaders = connection.auth_header ? [connection.auth_header] : [];

  // safeFetch (#219) applies the SSRF egress guard at fetch time (private/reserved targets
  // refused, IP-pinned, redirects refused). A blocked target throws and fails the run.
  const res = await safeFetch(url, { method: "GET", headers, allowedHeaders });
  if (!res.ok) {
    throw new Error(`Dataset source ${connection.endpoint} returned HTTP ${res.status}`);
  }

  const json = await res.json();
  const rows = getByPath(json, connection.response_path);
  if (!Array.isArray(rows)) {
    throw new Error(
      `Dataset response_path '${connection.response_path}' did not resolve to an array`
    );
  }

  const fieldMap = ((connection.config as { field_map?: FieldMap } | null)?.field_map ?? {}) as FieldMap;
  return rows.map((row) => mapRow(row, fieldMap));
};
