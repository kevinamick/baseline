// Shared helpers for talking to customer systems: render {{placeholder}} templates
// and pull values out of arbitrary JSON by dotted path. Used by the agent invoker
// (agent.ts) and the dataset adapters (adapters/*).

// Replace {{user_input}} etc. anywhere inside a JSON template (string/array/object).
export function renderTemplate(template: unknown, vars: Record<string, string>): unknown {
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

// Walk a dotted path, e.g. 'output' or 'choices.0.message.content' or '' (the root).
// Returns undefined if any segment is missing — never throws.
export function getByPath(obj: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed === "") return obj;
  let current: unknown = obj;
  for (const segment of trimmed.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// Coerce a JSON value to a string (objects/arrays are JSON-stringified); null/undefined
// become null so callers can distinguish "missing" from "empty string".
export function stringifyValue(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

// Extract a required string value at a dotted path; throws if it doesn't resolve.
export function extractString(obj: unknown, path: string): string {
  const value = getByPath(obj, path);
  if (value == null) {
    throw new Error(`response_path '${path}' did not resolve to a value`);
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}
