export interface LLMJudgeResult {
  score: number;
  reasoning: string;
}

export interface LLMProvider {
  judge(systemPrompt: string, userContent: string): Promise<LLMJudgeResult>;
}
