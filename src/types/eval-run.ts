export type EvalRunStatus = "queued" | "running" | "completed" | "failed";

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
