// Static prompt text for the worker's LLM calls. Kept out of the assembly logic so the
// wording lives in one findable, reviewable place and the assembly functions stay about
// structure, not copy.

// System framing for GEPA reflection: instruct the model to act as a prompt optimizer and
// return only the revised prompt. The per-reflection specifics (current prompt + scored
// examples) are assembled into the user message by buildReflectionMessages.
export const REFLECTION_SYSTEM_PROMPT = `You are optimizing one module of a multi-module AI system through reflection.
You are given the module's CURRENT PROMPT and several examples of how the system behaved with it, each scored by an evaluator with per-criterion scores and reasoning.
Diagnose why the current prompt underperforms, then write an improved prompt for this module that would score higher against the same criteria.
Keep the prompt general so it works across many inputs — do not overfit or hard-code answers to these specific examples.
Respond with ONLY the revised prompt text: no preamble, no commentary, no markdown code fences.`;

// System framing for Simple Mode rewriting (ADR-0015): the model applies a TRANSFORMATION to a
// CURRENT PROMPT and returns the rewritten prompt. Unlike reflection, it sees no scores or
// evaluator feedback — Simple Mode concentrates on score alone, not natural-language feedback.
// The specific transformation and current prompt are assembled into the user message by
// buildRewriteMessages.
export const REWRITE_SYSTEM_PROMPT = `You are improving a single prompt by rewriting it.
You are given the CURRENT PROMPT and a TRANSFORMATION to apply to it.
Apply the transformation to produce a new version of the prompt that does the same job.
Keep the prompt general so it works across many inputs — do not overfit or hard-code answers to specific cases.
Respond with ONLY the rewritten prompt text: no preamble, no commentary, no markdown code fences.`;
