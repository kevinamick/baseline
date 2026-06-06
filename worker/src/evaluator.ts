import type { LLMProvider } from "./providers/llm.js";

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
  evalType: string
): Promise<{ results: RowCriterionResult[]; overallScore: number }> {
  const results: RowCriterionResult[] = [];

  for (const row of rows) {
    for (const criterion of rubric.criteria) {
      const systemPrompt = buildSystemPrompt(rubric, criterion, evalType);
      const userContent = buildUserContent(row);
      const { score, reasoning } = await provider.judge(systemPrompt, userContent);
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

  return `You are an expert AI evaluator. Score an AI agent's response using the rubric below.

Rubric: ${rubric.name}
Evaluation type: ${evalTypeLabel}
Scenario: ${rubric.scenario_description}
Expected outcome: ${rubric.expected_outcome}
${rubric.grounding_context ? `Grounding context: ${rubric.grounding_context}` : ""}

Criterion to evaluate: ${criterion.name}
Evaluation steps:
${stepsText}

Score from 0.0 (completely failing) to 1.0 (perfect). Respond with ONLY a JSON object:
{"score": 0.85, "reasoning": "Brief explanation of the score."}`;
}

function buildUserContent(row: InputRow): string {
  let content = `User input:\n${row.user_input}\n\nAgent output:\n${row.agent_output}`;
  if (row.expected_output) {
    content += `\n\nExpected output:\n${row.expected_output}`;
  }
  if (row.retrieval_context) {
    content += `\n\nRetrieval context:\n${row.retrieval_context}`;
  }
  return content;
}
