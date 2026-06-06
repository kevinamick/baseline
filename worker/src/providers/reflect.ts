// Pure reflection helpers: assemble the prompt sent to the reflection model and recover the
// proposed prompt from its reply. No I/O, so they unit-test without an API client.
// AnthropicProvider.propose() wires these around the actual messages.create call.

import type { ProposeInput, ReflectionExample } from "./llm.js";
import { REFLECTION_SYSTEM_PROMPT } from "./prompts.js";

// Build the {system, user} messages for one reflection. The system message frames the model
// as a prompt optimizer; the user message carries the current prompt and the scored examples.
export function buildReflectionMessages(input: ProposeInput): { system: string; user: string } {
  const system = REFLECTION_SYSTEM_PROMPT;

  const user = `Module to improve: ${input.targetModule}

Current prompt:
${input.currentPrompt || "(empty)"}

Examples of the current prompt's behavior, with evaluator feedback:
${input.examples.map(formatExample).join("\n\n")}

Write the improved prompt for the "${input.targetModule}" module now.`;

  return { system, user };
}

function formatExample(example: ReflectionExample, i: number): string {
  const feedback = example.criteria.length
    ? example.criteria
        .map((c) => `- ${c.name} (${c.score.toFixed(2)}): ${c.reasoning}`)
        .join("\n")
    : "- (no evaluator feedback)";
  return `[${i + 1}]
Input:
${example.userInput}
Output:
${example.agentOutput}
Evaluation:
${feedback}`;
}

// Recover the proposed prompt from the model's reply. The model is told to return raw text,
// but defensively strip a single wrapping ```fence``` if it adds one anyway. Only unwrap when
// the whole reply is exactly one fenced block (two fence markers) — otherwise a prompt that
// legitimately embeds a ``` example would be truncated at its first internal fence.
export function extractProposedPrompt(text: string): string {
  const trimmed = text.trim();
  if ((trimmed.match(/```/g) ?? []).length === 2) {
    const fenced = trimmed.match(/^```(?:[\w-]*)\n([\s\S]*?)\n```$/);
    if (fenced) return fenced[1].trim();
  }
  return trimmed;
}
