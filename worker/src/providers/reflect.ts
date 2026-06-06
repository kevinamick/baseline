// Pure reflection helpers: assemble the prompt sent to the reflection model and recover the
// proposed prompt from its reply. No I/O, so they unit-test without an API client.
// AnthropicProvider.propose() wires these around the actual messages.create call.

import type { ProposeInput, ReflectionExample } from "./llm.js";

// Build the {system, user} messages for one reflection. The system message frames the model
// as a prompt optimizer; the user message carries the current prompt and the scored examples.
export function buildReflectionMessages(input: ProposeInput): { system: string; user: string } {
  const system = `You are optimizing one module of a multi-module AI system through reflection.
You are given the module's CURRENT PROMPT and several examples of how the system behaved with it, each scored by an evaluator with per-criterion scores and reasoning.
Diagnose why the current prompt underperforms, then write an improved prompt for this module that would score higher against the same criteria.
Keep the prompt general so it works across many inputs — do not overfit or hard-code answers to these specific examples.
Respond with ONLY the revised prompt text: no preamble, no commentary, no markdown code fences.`;

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
