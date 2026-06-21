/**
 * Token usage from one LLM call (#185). Captured on every judge/propose so the
 * managed meter can price the call from actual token counts. Models that don't
 * report usage leave this undefined — the meter treats that as a fail-closed
 * unpriceable call.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** The model that produced this usage — what the price table is keyed on. */
  model: string;
}

export interface LLMJudgeResult {
  score: number;
  reasoning: string;
  /** Token usage for this judge call (#185); undefined if the SDK didn't report it. */
  usage?: TokenUsage;
}

/** A reflection proposal plus its token usage (#185). */
export interface ProposeResult {
  prompt: string;
  usage?: TokenUsage;
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
  propose(input: ProposeInput): Promise<ProposeResult>;
}
