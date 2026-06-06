export interface LLMJudgeResult {
  score: number;
  reasoning: string;
}

// One scored example fed to reflection: what the system produced for an input, plus the
// judge's per-criterion verdict. These are the parent Candidate's minibatch rollouts.
export interface ReflectionExample {
  userInput: string;
  agentOutput: string;
  criteria: { name: string; score: number; reasoning: string }[];
}

// The reflection request (GEPA): improve one Module's prompt given how the current prompt
// performed on a minibatch, judged against the Rubric.
export interface ProposeInput {
  targetModule: string;
  currentPrompt: string;
  examples: ReflectionExample[];
}

export interface LLMProvider {
  judge(systemPrompt: string, userContent: string): Promise<LLMJudgeResult>;
  // Reflect on minibatch feedback and return a revised prompt for the target Module.
  propose(input: ProposeInput): Promise<string>;
}
