// {{prompt:<name>}} is the placeholder a request template uses to inject a Module's prompt at
// rollout time. The wizard, the schemas, and the save boundary all need to know which Modules a
// template references, to cross-check them against the declared Modules.
//
// The actual extraction lives in worker/src/prompt-refs.ts so the save-time validation and the
// worker's invocation-time guard share ONE implementation (issue #94) — it sits on the worker
// side because the worker's Docker build copies only worker/. This module re-exports it for app
// code; do not reimplement the regex here.

import { referencedModules } from "../../../worker/src/prompt-refs";

export {
  referencedModules,
  undeclaredPromptRefsMessage,
  validateTemplateModuleRefs,
} from "../../../worker/src/prompt-refs";

// The distinct Module names referenced as {{prompt:<name>}} in a template string, in
// first-seen order. Module names use the same [A-Za-z0-9_-] charset OptimizablePromptSchema
// enforces.
//
// When the string parses as JSON, the PARSED value is scanned so the traversal matches
// renderTemplate exactly — only string values count; a {{prompt:x}} in an object KEY is
// never substituted by the renderer and must not satisfy the declared↔referenced
// cross-check (it would pass wizard validation for a prompt the agent never receives).
// The raw-string scan is only a best-effort fallback for a wizard textarea that isn't
// valid JSON yet; those templates are rejected by the JSON-validity check before any
// cross-check can let them through.
export function extractPromptRefs(template: string): string[] {
  let parsed: unknown = template;
  try {
    parsed = JSON.parse(template);
  } catch {
    // Not valid JSON (yet) — scan the raw string for live wizard hints.
  }
  return [...referencedModules(parsed)];
}
