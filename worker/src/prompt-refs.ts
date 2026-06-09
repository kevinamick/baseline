// {{prompt:<name>}} is the placeholder a request template uses to inject a Module's
// prompt at rollout time. This file is THE single reference-extraction implementation:
// the worker's invocation-time guard (invokeAgent) and the app's save-time validation
// (insertConnection, NewOptimizationConnectionSchema, the wizard) all call it, so the
// two checks can never drift apart (issue #94).
//
// It lives in worker/src — not src/lib — because the worker's Docker build copies only
// the worker/ directory (see worker/Dockerfile), while the Next.js app can reach across
// the repo; src/lib/optimization/prompt-refs.ts re-exports it for app code.

// Module names use the same [A-Za-z0-9_-] charset OptimizablePromptSchema enforces.
const PROMPT_REF = /\{\{\s*prompt:([A-Za-z0-9_-]+)\s*\}\}/g;

// The distinct Module names a template references via {{prompt:<module>}}, in first-seen
// order. Mirrors renderTemplate's traversal exactly — only string values are scanned
// (object keys are never substituted), so the guards and the renderer agree on what
// counts as a reference. Accepts a parsed JSON template (object/array) or a raw string.
export function referencedModules(template: unknown, found = new Set<string>()): Set<string> {
  if (typeof template === "string") {
    for (const match of template.matchAll(PROMPT_REF)) found.add(match[1]);
  } else if (Array.isArray(template)) {
    for (const item of template) referencedModules(item, found);
  } else if (template && typeof template === "object") {
    for (const value of Object.values(template)) referencedModules(value, found);
  }
  return found;
}

// Shared error text naming the offending Module(s), so the save-time rejection reads
// exactly like the invocation-time failure.
export function undeclaredPromptRefsMessage(undeclared: string[]): string {
  return `Request template references {{prompt:}} Module(s) not declared on the Connection: ${undeclared.join(", ")}`;
}
