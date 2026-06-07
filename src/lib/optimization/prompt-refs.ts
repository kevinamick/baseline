// {{prompt:<name>}} is the placeholder a request template uses to inject a Module's prompt at
// rollout time. The wizard and the schema both need to know which Modules a template references,
// to cross-check them against the declared Modules (a launch fails later if they don't match).

const PROMPT_REF = /\{\{\s*prompt:([A-Za-z0-9_-]+)\s*\}\}/g;

// The distinct Module names referenced as {{prompt:<name>}} in a request template, in first-seen
// order. Module names use the same [A-Za-z0-9_-] charset OptimizablePromptSchema enforces.
export function extractPromptRefs(template: string): string[] {
  const seen = new Set<string>();
  for (const match of template.matchAll(PROMPT_REF)) seen.add(match[1]);
  return [...seen];
}
