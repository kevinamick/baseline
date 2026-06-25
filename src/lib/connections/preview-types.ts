// Client-safe shape + bounds for the dataset "Test query" preview (#39). No node/server
// imports live here so the schedule wizard's client component can import the row shape, the
// error/warning codes, and the preview bounds. The actual fetch — which reuses the worker's
// dataset adapter seam (and pulls in node:http via safeFetch) — lives in the server-only
// preview.ts; the two stay in sync through these shared constants and types.

// A preview is intentionally tiny: it proves the query/auth/mapping work, it is not a real
// fetch, so it must never hammer the source. Last hour, a handful of rows, a short leash.
export const PREVIEW_MAX_ROWS = 5;
export const PREVIEW_WINDOW_MINUTES = 60;
export const PREVIEW_TIMEOUT_MS = 15_000;

// One row exactly as Baseline maps it into the scoring fields (mirrors the worker's
// DatasetRow). Showing these four columns is the whole point: it makes a wrong HogQL alias or
// field-map path visible (the value lands empty) before the schedule is ever saved.
export interface PreviewRow {
  user_input: string;
  agent_output: string;
  expected_output: string | null;
  retrieval_context: string | null;
}

// A categorized failure so the client renders a clear, translated headline; `detail` carries
// the adapter's own diagnostic (HTTP status, the unresolved rows path) verbatim for a muted
// secondary line. Codes map 1:1 to Schedules.wizard.preview.error.* message keys.
export type PreviewErrorCode =
  | "auth" // bad API key / wrong project id → 401/403
  | "endpoint" // SSRF/policy refusal, DNS failure, blocked host/port, refused redirect
  | "rows_path" // the configured rows path didn't resolve to an array
  | "parse" // the response body wasn't valid JSON
  | "timeout" // the source didn't answer within PREVIEW_TIMEOUT_MS
  | "config" // the spec itself is malformed (bad template JSON, missing project_id/hogql)
  | "forbidden" // not signed in, or not a contributor
  | "unknown"; // anything else — detail still carries the raw message

// A soft signal: rows came back, but nothing mapped into user_input/agent_output, so the
// HogQL aliases or field-map paths almost certainly don't match the data. Surfaced alongside
// the rows (not as an error) so the user sees the empty columns AND why.
export type PreviewWarningCode = "no_columns_mapped";

export type PreviewResult =
  | { rows: PreviewRow[]; warning?: PreviewWarningCode }
  | { error: PreviewErrorCode; detail?: string };
