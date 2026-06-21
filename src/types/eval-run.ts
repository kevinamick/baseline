// 'skipped' is a terminal, non-scoring outcome: a dataset run whose window returned no
// usable rows. It is neither success nor failure — excluded from score trends, no email.
export type EvalRunStatus = "queued" | "running" | "completed" | "failed" | "skipped";

export interface EvalRunRow {
  userInput: string;
  agentOutput: string;
  expectedOutput?: string;
  retrievalContext?: string;
}

export interface EvalRunResult {
  rowIndex: number;
  criterionName: string;
  score: number;
  reasoning: string;
}

export interface EvalRun {
  id: string;
  rubricId: string;
  status: EvalRunStatus;
  evalType: string;
  description: string | null;
  notificationEmails: string[];
  overallScore: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface EvalRunDetails extends EvalRun {
  results: EvalRunResult[];
}

export interface EvalRunRowData {
  rowIndex: number;
  userInput: string;
  agentOutput: string;
  expectedOutput?: string | null;
}

export interface RunComparisonSide extends EvalRunDetails {
  rows: EvalRunRowData[];
}

export interface EvalRunComparison {
  runA: RunComparisonSide;
  runB: RunComparisonSide;
}
