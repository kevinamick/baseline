import { describe, it, expect } from "vitest";
import { referencedModules, undeclaredPromptRefsMessage } from "./prompt-refs.js";

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
