export type EvaluationMode = "conversational" | "prompt_response";

export interface Criterion {
  name: string;
  weight: number;
  steps: string[];
}

export interface Rubric {
  id: string;
  created_by: string;
  name: string;
  scenario_description: string;
  expected_outcome: string;
  evaluation_mode: EvaluationMode;
  grounding_context: string | null;
  criteria: Criterion[];
  created_at: string;
  updated_at: string;
}

export type RubricSummary = Pick<
  Rubric,
  "id" | "name" | "evaluation_mode" | "created_at"
> & {
  /**
   * Criterion count for the pre-run Eval Point cost display. Optional because
   * some surfaces (schedules, optimizations pickers) don't load criteria; the
   * run dialog omits the cost line when it's absent.
   */
  criteriaCount?: number;
};
