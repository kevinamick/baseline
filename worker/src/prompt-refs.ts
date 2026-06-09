// {{prompt:<name>}} is the placeholder a request template uses to inject a Module's
// prompt at rollout time. This file is THE single reference-extraction implementation:
// the worker's invocation-time guard (invokeAgent) and the app's save-time validation
// (insertConnection, NewOptimizationConnectionSchema, the wizard) all call it, so the
// two checks can never drift apart (issue #94).
//
// It lives in worker/src — not src/lib — because the worker's Docker build copies only
// the worker/ directory (see worker/Dockerfile), while the Next.js app can reach across
// the repo; src/lib/optimization/prompt-refs.ts re-exports it for app code.
//
// INVARIANT: this file must stay import-free (no imports, not even worker-local ones).
// The Next.js app bundles it directly, so any worker-side dependency added here would
// leak into the app bundle — or break the Next build outright (NodeNext ".js" specifiers,
// worker-only deps like @temporalio/*). src/lib/optimization/prompt-refs.test.ts has a
// guard test that fails if an import sneaks in.

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

// The cross-field rule of issue #94, as ONE pure function so every boundary that persists
// or executes a template applies it identically: insertConnection (create), the upcoming
// modules-editor update path (#119), and the worker's invocation-time guard (invokeAgent).
//
// - A referenced-but-undeclared Module is a hard error: the renderer would substitute ""
//   and the agent would silently receive an empty prompt.
// - A declared-but-unreferenced Module is only a soft warning: the row is valid, the agent
//   just never sees that prompt. Callers decide whether to surface it.
export function validateTemplateModuleRefs(
  template: unknown,
  declared: Iterable<string>
): { error: string } | { warning?: string } {
  const declaredNames = new Set(declared);
  const referenced = referencedModules(template);
  const undeclared = [...referenced].filter((name) => !declaredNames.has(name));
  if (undeclared.length > 0) {
    return { error: undeclaredPromptRefsMessage(undeclared) };
  }
  const unreferenced = [...declaredNames].filter((name) => !referenced.has(name));
  if (unreferenced.length > 0) {
    return {
      warning: `Declared Module(s) never referenced by the request template: ${unreferenced.join(", ")}. The agent will not receive these prompts.`,
    };
  }
  return {};
}
