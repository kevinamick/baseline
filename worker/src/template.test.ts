import { describe, it, expect } from "vitest";
import { renderTemplate } from "./template.js";

// renderTemplate splits placeholders by source: bare {{name}} reads `vars` (row data),
// {{prompt:name}} reads `prompts` (a Candidate's / seed Module map).

describe("renderTemplate placeholder sources", () => {
  it("fills row vars and prompt vars from their separate maps in one pass", () => {
    const template = { system: "{{prompt:system}}", message: "{{user_input}}" };
    expect(
      renderTemplate(template, { user_input: "hi" }, { system: "be kind" })
    ).toEqual({ system: "be kind", message: "hi" });
  });

  it("recurses through arrays and nested objects", () => {
    const template = {
      messages: [
        { role: "system", content: "{{prompt:system}}" },
        { role: "user", content: "{{user_input}}" },
      ],
    };
    expect(
      renderTemplate(template, { user_input: "ping" }, { system: "sys" })
    ).toEqual({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "ping" },
      ],
    });
  });

  it("renders missing keys (and an absent prompts map) as empty strings", () => {
    expect(renderTemplate("{{prompt:missing}}/{{also_missing}}", {})).toBe("/");
  });

  it("does not read a prompt Module from row vars or vice versa", () => {
    // A bare {{system}} must NOT pick up the `system` prompt; only {{prompt:system}} does.
    expect(
      renderTemplate("{{system}}|{{prompt:system}}", { system: "row" }, { system: "module" })
    ).toBe("row|module");
  });

  it("supports hyphenated and underscored Module names", () => {
    expect(
      renderTemplate("{{prompt:few-shot}}{{prompt:tone_guide}}", {}, { "few-shot": "a", tone_guide: "b" })
    ).toBe("ab");
  });

  it("leaves non-string scalars untouched", () => {
    expect(renderTemplate({ n: 1, b: true, z: null }, {})).toEqual({ n: 1, b: true, z: null });
  });
});
