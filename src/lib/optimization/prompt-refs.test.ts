import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { extractPromptRefs } from "./prompt-refs";

describe("extractPromptRefs", () => {
  it("extracts distinct module names from {{prompt:*}} placeholders", () => {
    const tpl = '{"input":"{{user_input}}","system":"{{prompt:system}}","style":"{{prompt:style}}"}';
    expect(extractPromptRefs(tpl)).toEqual(["system", "style"]);
  });

  it("ignores non-prompt placeholders like {{user_input}}", () => {
    expect(extractPromptRefs('{"input":"{{user_input}}"}')).toEqual([]);
  });

  it("dedupes repeated references and preserves first-seen order", () => {
    expect(extractPromptRefs("{{prompt:b}} {{prompt:a}} {{prompt:b}}")).toEqual(["b", "a"]);
  });

  it("tolerates internal whitespace in the placeholder", () => {
    expect(extractPromptRefs("{{ prompt:system }}")).toEqual(["system"]);
  });

  it("returns [] when there are no references", () => {
    expect(extractPromptRefs("{}")).toEqual([]);
  });

  // The renderer only substitutes string VALUES, so a ref that exists only in an object
  // key must not count — otherwise the wizard/schema cross-check passes for a prompt the
  // agent never receives (the silent failure #94 exists to prevent).
  it("ignores {{prompt:}} tokens in JSON object keys, matching the renderer's traversal", () => {
    expect(extractPromptRefs('{"{{prompt:system}}":"literal","input":"{{user_input}}"}')).toEqual(
      []
    );
  });

  it("still finds refs in values (including nested) when keys also carry tokens", () => {
    const tpl = '{"{{prompt:ghost}}":"x","messages":[{"content":"{{prompt:system}}"}]}';
    expect(extractPromptRefs(tpl)).toEqual(["system"]);
  });

  it("falls back to a raw-string scan while the template is not valid JSON yet", () => {
    expect(extractPromptRefs('{"system": "{{prompt:system}}", not json')).toEqual(["system"]);
  });
});

// worker/src/prompt-refs.ts is bundled into the Next.js app via the re-export above, so it
// must stay import-free: a worker-local import (NodeNext ".js" specifier, @temporalio/*, …)
// would compile fine for the worker and only break the Next build — or silently pull worker
// code into the app bundle. Fail here, closest to the cause.
describe("worker/src/prompt-refs.ts cross-package invariant", () => {
  it("contains no import or require statements", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../../../worker/src/prompt-refs.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    // Re-export form (`export { x } from "./y"`) is an import too.
    expect(source).not.toMatch(/^\s*export\s*[{*][^;]*?from\s*["']/m);
  });
});
