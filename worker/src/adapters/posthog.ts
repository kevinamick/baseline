// PostHog dataset adapter: run a HogQL query against the PostHog query API. The window
// and row cap are rendered into the stored HogQL ({{window_start}} etc.); the query is
// expected to SELECT columns aliased to our field names, so we map results by column.

import { renderTemplate, stringifyValue } from "../template.js";
import type { DatasetAdapter, DatasetConnection, DatasetRow, FetchContext } from "./types.js";

interface PostHogConfig {
  project_id?: string;
  hogql?: string;
}

interface PostHogQueryResponse {
  results?: unknown[][];
  columns?: string[];
}

export const posthogDatasetAdapter: DatasetAdapter = async (
  connection: DatasetConnection,
  ctx: FetchContext
): Promise<DatasetRow[]> => {
  const cfg = (connection.config ?? {}) as PostHogConfig;
  if (!cfg.project_id || !cfg.hogql) {
    throw new Error("PostHog connection is missing project_id or hogql");
  }

  const query = renderTemplate(cfg.hogql, {
    window_start: ctx.windowStart,
    window_end: ctx.windowEnd,
    max_rows: String(ctx.maxRows),
  }) as string;

  const base = connection.endpoint.replace(/\/$/, "");
  const url = `${base}/api/projects/${cfg.project_id}/query/`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (connection.auth_header && ctx.authValue) {
    headers[connection.auth_header] = ctx.authValue;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  if (!res.ok) {
    throw new Error(`PostHog query returned HTTP ${res.status}`);
  }

  const json = (await res.json()) as PostHogQueryResponse;
  const columns = json.columns ?? [];
  const results = json.results ?? [];

  const col = (name: string) => columns.indexOf(name);
  const ui = col("user_input");
  const ao = col("agent_output");
  const eo = col("expected_output");
  const rc = col("retrieval_context");

  return results.map((row) => ({
    user_input: ui >= 0 ? stringifyValue(row[ui]) ?? "" : "",
    agent_output: ao >= 0 ? stringifyValue(row[ao]) ?? "" : "",
    expected_output: eo >= 0 ? stringifyValue(row[eo]) : null,
    retrieval_context: rc >= 0 ? stringifyValue(row[rc]) : null,
  }));
};
