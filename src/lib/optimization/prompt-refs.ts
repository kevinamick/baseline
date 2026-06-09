// {{prompt:<name>}} is the placeholder a request template uses to inject a Module's prompt at
// rollout time. The wizard, the schemas, and the save boundary all need to know which Modules a
// template references, to cross-check them against the declared Modules.
//
// The actual extraction lives in worker/src/prompt-refs.ts so the save-time validation and the
// worker's invocation-time guard share ONE implementation (issue #94) — it sits on the worker
// side because the worker's Docker build copies only worker/. This module re-exports it for app
// code; do not reimplement the regex here.

import { referencedModules } from "../../../worker/src/prompt-refs";

export { referencedModules, undeclaredPromptRefsMessage } from "../../../worker/src/prompt-refs";

// The distinct Module names referenced as {{prompt:<name>}} in a raw template string, in
// first-seen order. Module names use the same [A-Za-z0-9_-] charset OptimizablePromptSchema
// enforces.
export function extractPromptRefs(template: string): string[] {
  return [...referencedModules(template)];
}
