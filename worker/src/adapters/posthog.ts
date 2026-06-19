// PostHog dataset adapter: run a HogQL query against the PostHog query API. The window
// and row cap are rendered into the stored HogQL ({{window_start}} etc.); the query is
// expected to SELECT columns aliased to our field names, so we map results by column.

import { renderTemplate, stringifyValue } from "../template.js";
import { safeFetch, tenantRequestHeaders } from "../safe-fetch.js";
import { isAllowedPosthogHost } from "./posthog-hosts.js";
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

  // Restrict the adapter to PostHog hosts (#221). The generic SSRF guard in safeFetch only
  // blocks private/reserved targets; without this a tenant could point the adapter at any
  // public host. Enforced here at fetch time — independently of the save-time check — so a
  // connection persisted before this list existed (or by a path that skipped validation)
  // still can't reach a non-PostHog host.
  let host: string;
  try {
    host = new URL(connection.endpoint).hostname;
  } catch {
    throw new Error(`PostHog endpoint is not a valid URL: ${connection.endpoint}`);
  }
  if (!isAllowedPosthogHost(host)) {
    throw new Error(`PostHog endpoint host is not an allowed PostHog host: ${host}`);
  }

  const base = connection.endpoint.replace(/\/$/, "");
  const url = `${base}/api/projects/${cfg.project_id}/query/`;

  // Outbound headers + their matching allowlist (#222): even though the host is PostHog-
  // restricted (above), still send only the JSON content type and the Connection's auth header
  // — safeFetch drops anything else, so no internal / telemetry header can leak.
  const { headers, allowedHeaders } = tenantRequestHeaders({
    authHeader: connection.auth_header,
    authValue: ctx.authValue,
    json: true,
  });

  // safeFetch (#219) applies the SSRF egress guard at fetch time (private/reserved targets
  // refused, IP-pinned, redirects refused). A blocked target throws and fails the run.
  const res = await safeFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    allowedHeaders,
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
