// Agent Connection invocation: turn a fixed input row into a fresh agent_output by
// calling the customer's existing HTTP endpoint. The Connection adapts to their API
// shape via a request body template ({{placeholders}}) and a dotted response path.

import { renderTemplate, extractString } from "./template.js";

export interface AgentConnection {
  id: string;
  kind: string;
  endpoint: string;
  auth_header: string | null;
  auth_secret_id: string | null;
  request_template: unknown;
  response_path: string;
}

export interface InvokableRow {
  row_index: number;
  user_input: string;
  expected_output: string | null;
  retrieval_context: string | null;
}

// Invoke the agent once for a single input row and return its output.
export async function invokeAgent(
  connection: AgentConnection,
  row: InvokableRow,
  authValue: string | null
): Promise<string> {
  const vars: Record<string, string> = {
    user_input: row.user_input,
    expected_output: row.expected_output ?? "",
    retrieval_context: row.retrieval_context ?? "",
  };

  const template = connection.request_template ?? { input: "{{user_input}}" };
  const body = renderTemplate(template, vars);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // The stored secret IS the full header value (e.g. "Bearer sk-..."), so it is used verbatim.
  if (connection.auth_header && authValue) {
    headers[connection.auth_header] = authValue;
  }

  const res = await fetch(connection.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Agent endpoint ${connection.endpoint} returned HTTP ${res.status}`);
  }

  const json = await res.json();
  return extractString(json, connection.response_path);
}
