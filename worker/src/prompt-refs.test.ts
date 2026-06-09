import { describe, it, expect } from "vitest";
import {
  referencedModules,
  undeclaredPromptRefsMessage,
  validateTemplateModuleRefs,
} from "./prompt-refs.js";

// The single shared extraction used by both the worker's invocation-time guard and the
// app's save-time validation (issue #94). String-level behavior is also exercised via the
// app's extractPromptRefs wrapper tests; this file covers the parsed-template traversal.

describe("referencedModules", () => {
  it("collects {{prompt:*}} refs from nested objects and arrays", () => {
    const template = {
      system: "{{prompt:system}}",
      messages: [{ content: "{{prompt:few_shot}} then {{user_input}}" }],
      meta: { style: "{{prompt:style}}" },
    };
    expect([...referencedModules(template)]).toEqual(["system", "few_shot", "style"]);
  });

  it("scans raw strings too (the app validates the unsaved textarea value)", () => {
    expect([...referencedModules("{{prompt:b}} {{ prompt:a }} {{prompt:b}}")]).toEqual(["b", "a"]);
  });

  it("ignores object keys and non-prompt placeholders", () => {
    const template = { "{{prompt:ghost}}": "literal", input: "{{user_input}}" };
    expect(referencedModules(template).size).toBe(0);
  });

  it("returns an empty set for null/number/template-free values", () => {
    expect(referencedModules(null).size).toBe(0);
    expect(referencedModules(42).size).toBe(0);
    expect(referencedModules({ input: "plain" }).size).toBe(0);
  });
});

describe("undeclaredPromptRefsMessage", () => {
  it("names every offending Module", () => {
    expect(undeclaredPromptRefsMessage(["systme", "style"])).toBe(
      "Request template references {{prompt:}} Module(s) not declared on the Connection: systme, style"
    );
  });
});

// The single cross-field rule (#94) shared by insertConnection, the #119 update path, and
// the worker's invocation-time guard.
describe("validateTemplateModuleRefs", () => {
  it("passes when declared and referenced Modules match exactly", () => {
    const template = { system: "{{prompt:system}}", input: "{{user_input}}" };
    expect(validateTemplateModuleRefs(template, ["system"])).toEqual({});
  });

  it("hard-errors on a referenced-but-undeclared Module, with the shared message", () => {
    const template = { system: "{{prompt:systme}}" };
    expect(validateTemplateModuleRefs(template, ["system"])).toEqual({
      error: undeclaredPromptRefsMessage(["systme"]),
    });
  });

  it("soft-warns (not errors) on a declared-but-unreferenced Module", () => {
    const result = validateTemplateModuleRefs({ input: "{{user_input}}" }, ["system"]);
    expect(result).toEqual({
      warning:
        "Declared Module(s) never referenced by the request template: system. The agent will not receive these prompts.",
    });
  });

  it("reports the error (not the warning) when both conditions hold", () => {
    const result = validateTemplateModuleRefs({ a: "{{prompt:ghost}}" }, ["system"]);
    expect(result).toEqual({ error: undeclaredPromptRefsMessage(["ghost"]) });
  });

  it("ignores {{prompt:}} tokens in object keys (renderer traversal)", () => {
    const template = { "{{prompt:system}}": "literal", input: "{{user_input}}" };
    // The key ref does not count as referenced, so a declared `system` is unreferenced.
    expect(validateTemplateModuleRefs(template, ["system"])).toEqual({
      warning:
        "Declared Module(s) never referenced by the request template: system. The agent will not receive these prompts.",
    });
  });
});
