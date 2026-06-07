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
});
