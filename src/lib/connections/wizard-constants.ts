// Shared constants for the connection-create form — used by both the schedule wizard
// (schedule-wizard.tsx) and the standalone Add Connection dialog (connections-list.tsx).

export const CONN_TYPE = {
  agent: "agent",
  managedAgent: "managed_agent",
  customDataset: "custom_dataset",
  posthogDataset: "posthog_dataset",
} as const;

export type ConnType = (typeof CONN_TYPE)[keyof typeof CONN_TYPE];

export const DEFAULT_AGENT_TEMPLATE = `{
  "input": "{{user_input}}"
}`;

export const DEFAULT_QUERY_TEMPLATE = `{
  "from": "{{window_start}}",
  "to": "{{window_end}}",
  "limit": "{{max_rows}}"
}`;

export const DEFAULT_HOGQL = `SELECT
  properties.$ai_input AS user_input,
  properties.$ai_output_choices AS agent_output
FROM events
WHERE event = '$ai_generation'
  AND timestamp >= '{{window_start}}'
  AND timestamp <  '{{window_end}}'
LIMIT {{max_rows}}`;
