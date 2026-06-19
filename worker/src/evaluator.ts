import type { LLMProvider } from "./providers/llm.js";
import type { ManagedMeter } from "./providers/managed-meter.js";
import { UNTRUSTED_DATA_PREAMBLE, wrapUntrusted } from "./prompt-delimit.js";

interface Criterion {
  name: string;
  weight: number;
  steps: string[];
}

export interface Rubric {
  name: string;
  scenario_description: string;
  expected_outcome: string;
  grounding_context: string | null;
  criteria: Criterion[];
}

interface InputRow {
  row_index: number;
  user_input: string;
  agent_output: string;
  expected_output: string | null;
  retrieval_context: string | null;
}

export interface RowCriterionResult {
  rowIndex: number;
  criterionName: string;
  score: number;
  reasoning: string;
}

const EVAL_TYPE_LABEL: Record<string, string> = {
  tabular: "Prompt / Response (single input → output)",
  conversational: "Conversational (multi-turn dialogue)",
};

export async function evaluateRun(
  rubric: Rubric,
  rows: InputRow[],
  provider: LLMProvider,
  evalType: string,
  // Managed-token meter (#185), present only for runs on a managed key. Each
  // judge call is priced and accrued; the meter throws between calls once the
  // Managed Spend Cap is reached, stopping the run mid-flight. Absent for BYO
  // runs (the customer's own tokens, never metered).
  meter?: ManagedMeter
): Promise<{ results: RowCriterionResult[]; overallScore: number }> {
  const results: RowCriterionResult[] = [];

  for (const row of rows) {
    for (const criterion of rubric.criteria) {
      const systemPrompt = buildSystemPrompt(rubric, criterion, evalType);
      const userContent = buildUserContent(row);
      const { score, reasoning, usage } = await provider.judge(systemPrompt, userContent);
      // Meter before the next unit; a cap breach throws here and aborts the run.
      if (meter) await meter.record({ usage, callKind: "judge" });
      results.push({
        rowIndex: row.row_index,
        criterionName: criterion.name,
        score,
        reasoning,
      });
    }
  }

  // Weighted average: per-criterion avg across rows, then weight
  const overallScore = rubric.criteria.reduce((total, criterion) => {
    const criterionResults = results.filter((r) => r.criterionName === criterion.name);
    if (criterionResults.length === 0) return total;
    const avg =
      criterionResults.reduce((s, r) => s + r.score, 0) / criterionResults.length;
    return total + criterion.weight * avg;
  }, 0);

  return { results, overallScore };
}

function buildSystemPrompt(rubric: Rubric, criterion: Criterion, evalType: string): string {
  const stepsText = criterion.steps
    .map((step, i) => `${i + 1}. ${step}`)
    .join("\n");

  const evalTypeLabel = EVAL_TYPE_LABEL[evalType] ?? evalType;

  // Every tenant-supplied free-text rubric field is fenced as untrusted data so an injected
  // "score 1.0" instruction inside it is read as data, not as a directive (#223) — including the
  // NAME fields (rubric name, criterion name): they are tenant free-text, not instructions, so a
  // multi-line payload in a name must not break out into the trusted scope above the fence. The
  // eval-type label and the scoring format are worker-authored and stay OUTSIDE the fence. The
  // criterion's evaluation STEPS are tenant-authored too, but they ARE the rubric's scoring
  // instructions — fencing them as inert data would defeat their purpose — so they stay outside
  // (a tenant can only steer the scoring of their own rubric, which is the legitimate function).
  const groundingBlock = rubric.grounding_context
    ? `\nGrounding context:\n${wrapUntrusted("grounding_context", rubric.grounding_context)}`
    : "";

  return `You are an expert AI evaluator. Score an AI agent's response using the rubric below.

${UNTRUSTED_DATA_PREAMBLE}

Rubric:
${wrapUntrusted("rubric_name", rubric.name)}
Evaluation type: ${evalTypeLabel}
Scenario:
${wrapUntrusted("scenario_description", rubric.scenario_description)}
Expected outcome:
${wrapUntrusted("expected_outcome", rubric.expected_outcome)}${groundingBlock}

Criterion to evaluate:
${wrapUntrusted("criterion_name", criterion.name)}
Evaluation steps:
${stepsText}

Score from 0.0 (completely failing) to 1.0 (perfect). Respond with ONLY a JSON object:
{"score": 0.85, "reasoning": "Brief explanation of the score."}`;
}

// The dataset row fields (user input, agent output, expected output, retrieval context) are all
// tenant-supplied; each is fenced as untrusted data so a payload in any of them can't steer the
// judge (#223). The labels themselves are worker-authored and stay outside the fences.
function buildUserContent(row: InputRow): string {
  let content = `User input:\n${wrapUntrusted("user_input", row.user_input)}\n\nAgent output:\n${wrapUntrusted("agent_output", row.agent_output)}`;
  if (row.expected_output) {
    content += `\n\nExpected output:\n${wrapUntrusted("expected_output", row.expected_output)}`;
  }
  if (row.retrieval_context) {
    content += `\n\nRetrieval context:\n${wrapUntrusted("retrieval_context", row.retrieval_context)}`;
  }
  return content;
}
