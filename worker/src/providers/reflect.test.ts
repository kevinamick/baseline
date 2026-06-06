import { describe, it, expect } from "vitest";
import { buildReflectionMessages, extractProposedPrompt } from "./reflect.js";
import type { ProposeInput } from "./llm.js";

describe("buildReflectionMessages", () => {
  const input: ProposeInput = {
    targetModule: "system",
    currentPrompt: "You are a helpful assistant.",
    examples: [
      {
        userInput: "How do I reset my password?",
        agentOutput: "Click the gear icon.",
        criteria: [
          { name: "accuracy", score: 0.4, reasoning: "Missed the actual reset link." },
          { name: "tone", score: 0.9, reasoning: "Friendly." },
        ],
      },
    ],
  };

  it("frames the system message as a prompt optimizer and forbids fences", () => {
    const { system } = buildReflectionMessages(input);
    expect(system).toMatch(/reflection/i);
    expect(system).toMatch(/ONLY the revised prompt/);
  });

  it("includes the target module, current prompt, and per-criterion feedback", () => {
    const { user } = buildReflectionMessages(input);
    expect(user).toContain("Module to improve: system");
    expect(user).toContain("You are a helpful assistant.");
    expect(user).toContain("How do I reset my password?");
    expect(user).toContain("Click the gear icon.");
    expect(user).toContain("accuracy (0.40): Missed the actual reset link.");
    expect(user).toContain("tone (0.90): Friendly.");
  });

  it("renders an empty current prompt as a placeholder", () => {
    const { user } = buildReflectionMessages({ ...input, currentPrompt: "" });
    expect(user).toContain("Current prompt:\n(empty)");
  });

  it("notes when an example has no evaluator feedback", () => {
    const { user } = buildReflectionMessages({
      ...input,
      examples: [{ userInput: "hi", agentOutput: "hello", criteria: [] }],
    });
    expect(user).toContain("(no evaluator feedback)");
  });
});

describe("extractProposedPrompt", () => {
  it("returns trimmed raw text unchanged", () => {
    expect(extractProposedPrompt("  Be concise and accurate.  ")).toBe("Be concise and accurate.");
  });

  it("strips a single wrapping code fence", () => {
    expect(extractProposedPrompt("```\nBe concise.\n```")).toBe("Be concise.");
  });

  it("strips a language-tagged fence", () => {
    expect(extractProposedPrompt("```text\nBe concise.\n```")).toBe("Be concise.");
  });

  it("leaves inline backticks inside the prompt intact", () => {
    expect(extractProposedPrompt("Use the `reset` command.")).toBe("Use the `reset` command.");
  });

  it("does not truncate a prompt that embeds its own fenced example", () => {
    const prompt = "Be concise.\n\nExample:\n```js\nfoo()\n```";
    // Wrapped in an outer fence by the model, but contains an inner fence: unwrapping would
    // truncate at the first inner fence, so leave the whole reply intact instead.
    expect(extractProposedPrompt("```\n" + prompt + "\n```")).toContain("foo()");
  });
});
