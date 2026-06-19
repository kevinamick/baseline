import { describe, it, expect } from "vitest";
import type { ZodTypeAny } from "zod";
import {
  RubricSchema,
  EvalRunRowSchema,
  ScheduleInputRowSchema,
  CreateScheduleSchema,
  OptimizationInstanceSchema,
  NewConnectionSchema,
} from "@/lib/validation/schemas";

// Mirrors the bounds single-sourced in schemas.ts. Kept here so a future widening/narrowing
// of a limit forces these expectations to move with it.
const SHORT_TEXT_MAX = 200;
const MEDIUM_TEXT_MAX = 2_000;
const LONG_TEXT_MAX = 262_144;
const AUTH_VALUE_MAX = 8_192;

const x = (n: number) => "x".repeat(n);

// #224 — every free-text field that used to be unbounded now carries an explicit .max().
// We assert the field accepts an at-limit value and rejects an over-limit one with a clear
// message. A `field` path of [] means the value IS the schema (no wrapping object).
type Case = {
  name: string;
  schema: ZodTypeAny;
  build: (text: string) => unknown;
  field: (string | number)[];
  max: number;
  message: string;
};

function validRubric(overrides: Record<string, unknown> = {}) {
  return {
    name: "Rubric",
    scenario_description: "A user asks a question.",
    expected_outcome: "The answer is correct.",
    evaluation_mode: "prompt_response" as const,
    criteria: [{ name: "Correctness", weight: 1, steps: ["Check the answer"] }],
    ...overrides,
  };
}

function validAgentConnection(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent" as const,
    name: "Agent",
    endpoint: "https://api.example.com/agent",
    authHeader: null,
    authValue: null,
    requestTemplate: '{"input":"{{user_input}}"}',
    responsePath: "output",
    optimizablePrompts: [],
    ...overrides,
  };
}

const cases: Case[] = [
  // ----- Rubric -----
  { name: "RubricSchema.name", schema: RubricSchema, build: (t) => validRubric({ name: t }), field: ["name"], max: SHORT_TEXT_MAX, message: "Name must be at most 200 characters" },
  { name: "RubricSchema.scenario_description", schema: RubricSchema, build: (t) => validRubric({ scenario_description: t }), field: ["scenario_description"], max: LONG_TEXT_MAX, message: "Scenario description must be at most 262144 characters" },
  { name: "RubricSchema.expected_outcome", schema: RubricSchema, build: (t) => validRubric({ expected_outcome: t }), field: ["expected_outcome"], max: LONG_TEXT_MAX, message: "Expected outcome must be at most 262144 characters" },
  { name: "RubricSchema.grounding_context", schema: RubricSchema, build: (t) => validRubric({ grounding_context: t }), field: ["grounding_context"], max: LONG_TEXT_MAX, message: "Grounding context must be at most 262144 characters" },
  { name: "RubricSchema.criteria[].name", schema: RubricSchema, build: (t) => validRubric({ criteria: [{ name: t, weight: 1, steps: ["s"] }] }), field: ["criteria", 0, "name"], max: SHORT_TEXT_MAX, message: "Criterion name must be at most 200 characters" },
  { name: "RubricSchema.criteria[].steps[]", schema: RubricSchema, build: (t) => validRubric({ criteria: [{ name: "C", weight: 1, steps: [t] }] }), field: ["criteria", 0, "steps", 0], max: MEDIUM_TEXT_MAX, message: "Step must be at most 2000 characters" },

  // ----- Eval-run row (the optional context fields the issue names) -----
  { name: "EvalRunRowSchema.userInput", schema: EvalRunRowSchema, build: (t) => ({ userInput: t, agentOutput: "a" }), field: ["userInput"], max: LONG_TEXT_MAX, message: "User input must be at most 262144 characters" },
  { name: "EvalRunRowSchema.agentOutput", schema: EvalRunRowSchema, build: (t) => ({ userInput: "u", agentOutput: t }), field: ["agentOutput"], max: LONG_TEXT_MAX, message: "Agent output must be at most 262144 characters" },
  { name: "EvalRunRowSchema.expectedOutput", schema: EvalRunRowSchema, build: (t) => ({ userInput: "u", agentOutput: "a", expectedOutput: t }), field: ["expectedOutput"], max: LONG_TEXT_MAX, message: "Expected output must be at most 262144 characters" },
  { name: "EvalRunRowSchema.retrievalContext", schema: EvalRunRowSchema, build: (t) => ({ userInput: "u", agentOutput: "a", retrievalContext: t }), field: ["retrievalContext"], max: LONG_TEXT_MAX, message: "Retrieval context must be at most 262144 characters" },

  // ----- Schedule input row -----
  { name: "ScheduleInputRowSchema.expectedOutput", schema: ScheduleInputRowSchema, build: (t) => ({ userInput: "u", expectedOutput: t }), field: ["expectedOutput"], max: LONG_TEXT_MAX, message: "Expected output must be at most 262144 characters" },
  { name: "ScheduleInputRowSchema.retrievalContext", schema: ScheduleInputRowSchema, build: (t) => ({ userInput: "u", retrievalContext: t }), field: ["retrievalContext"], max: LONG_TEXT_MAX, message: "Retrieval context must be at most 262144 characters" },

  // ----- Optimization instance -----
  { name: "OptimizationInstanceSchema.expectedOutput", schema: OptimizationInstanceSchema, build: (t) => ({ userInput: "u", expectedOutput: t }), field: ["expectedOutput"], max: LONG_TEXT_MAX, message: "Expected output must be at most 262144 characters" },
  { name: "OptimizationInstanceSchema.retrievalContext", schema: OptimizationInstanceSchema, build: (t) => ({ userInput: "u", retrievalContext: t }), field: ["retrievalContext"], max: LONG_TEXT_MAX, message: "Retrieval context must be at most 262144 characters" },

  // ----- Connection (auth, templates, paths) -----
  { name: "AgentConnection.authValue", schema: NewConnectionSchema, build: (t) => validAgentConnection({ authHeader: "Authorization", authValue: t }), field: ["authValue"], max: AUTH_VALUE_MAX, message: "Auth value must be at most 8192 characters" },
  { name: "AgentConnection.requestTemplate", schema: NewConnectionSchema, build: (t) => validAgentConnection({ requestTemplate: t }), field: ["requestTemplate"], max: LONG_TEXT_MAX, message: "Request template must be at most 262144 characters" },
  { name: "AgentConnection.responsePath", schema: NewConnectionSchema, build: (t) => validAgentConnection({ responsePath: t }), field: ["responsePath"], max: MEDIUM_TEXT_MAX, message: "Response path must be at most 2000 characters" },
];

describe("#224 free-text bounds — at-limit accepted, over-limit rejected", () => {
  for (const c of cases) {
    it(`${c.name} accepts a value exactly at the ${c.max}-char limit`, () => {
      const res = c.schema.safeParse(c.build(x(c.max)));
      // The field under test is at the limit; nothing else should fail it either.
      expect(res.success, res.success ? "" : JSON.stringify(res.error?.issues)).toBe(true);
    });

    it(`${c.name} rejects a value one char over the limit with a clear message`, () => {
      const res = c.schema.safeParse(c.build(x(c.max + 1)));
      expect(res.success).toBe(false);
      const issue = res.success
        ? undefined
        : res.error.issues.find((i) => i.path.map(String).join(".") === c.field.join("."));
      expect(issue?.message).toBe(c.message);
    });
  }
});

describe("#224 CreateScheduleSchema.description bound", () => {
  function validSchedule(description: string) {
    return {
      name: "Nightly",
      description,
      rubricId: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
      cadence: { frequency: "daily" as const, localHour: 9, timezone: "UTC" },
    };
  }

  it("accepts a description exactly at the 2000-char limit", () => {
    const res = CreateScheduleSchema.safeParse(validSchedule(x(MEDIUM_TEXT_MAX)));
    expect(res.success, res.success ? "" : JSON.stringify(res.error?.issues)).toBe(true);
  });

  it("rejects a description one char over the limit with a clear message", () => {
    const res = CreateScheduleSchema.safeParse(validSchedule(x(MEDIUM_TEXT_MAX + 1)));
    expect(res.success).toBe(false);
    const issue = res.success
      ? undefined
      : res.error.issues.find((i) => i.path.map(String).join(".") === "description");
    expect(issue?.message).toBe("Description must be at most 2000 characters");
  });
});
