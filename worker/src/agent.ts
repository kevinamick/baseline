// Agent Connection invocation: turn a fixed input row into a fresh agent_output by
// calling the customer's existing HTTP endpoint. The Connection adapts to their API
// shape via a request body template ({{placeholders}}) and a dotted response path.

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

// Replace {{user_input}} etc. anywhere inside a JSON template (string/array/object).
function renderTemplate(template: unknown, vars: Record<string, string>): unknown {
  if (typeof template === "string") {
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
  }
  if (Array.isArray(template)) {
    return template.map((item) => renderTemplate(item, vars));
  }
  if (template && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) {
      out[key] = renderTemplate(value, vars);
    }
    return out;
  }
  return template;
}

// Minimal dotted-path getter, e.g. 'output' or 'choices.0.message.content'.
function extractPath(obj: unknown, path: string): string {
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (current == null || typeof current !== "object") {
      current = undefined;
      break;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current == null) {
    throw new Error(`Connection response_path '${path}' did not resolve to a value`);
  }
  return typeof current === "string" ? current : JSON.stringify(current);
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
  return extractPath(json, connection.response_path);
}
