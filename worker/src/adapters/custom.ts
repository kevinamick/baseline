// Custom dataset adapter: GET the customer's log/trace API with the time window and row
// cap rendered into query-string params, then map each returned row object to our fields
// via a configured field_map. The mirror image of the custom agent adapter.

import { renderTemplate, getByPath, stringifyValue } from "../template.js";
import type { DatasetAdapter, DatasetConnection, DatasetRow, FetchContext } from "./types.js";

interface FieldMap {
  user_input?: string;
  agent_output?: string;
}

function mapRow(row: unknown, fieldMap: FieldMap): DatasetRow {
  return {
    user_input: stringifyValue(getByPath(row, fieldMap.user_input ?? "")) ?? "",
    agent_output: stringifyValue(getByPath(row, fieldMap.agent_output ?? "")) ?? "",
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

  const res = await fetch(url, { method: "GET", headers });
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
