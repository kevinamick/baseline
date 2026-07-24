import { describe, it, expect } from "vitest";
import type { ZodSafeParseResult } from "zod";
import {
  NewConnectionSchema,
  DatasetPreviewSchema,
  ScheduleInputRowSchema,
  ScheduleCadenceSchema,
  CreateScheduleSchema,
  OptimizationInstanceSchema,
  InstancesSourceSchema,
  NewOptimizationConnectionSchema,
  UpdateConnectionModulesSchema,
  UpdateManagedConnectionSchema,
  CreateOptimizationRunSchema,
  AccessCodeSchema,
  MAX_OPTIMIZATION_INSTANCES,
  DATASET_SNAPSHOT_MAX_WINDOW_MINUTES,
} from "@/lib/validation/schemas";
import { ENDPOINT_INTERNAL_MESSAGE } from "@/lib/connections/endpoint";
import { POSTHOG_HOST_MESSAGE } from "@/lib/connections/posthog-host";

// Boundary/message tests written to kill surviving Stryker mutants in schemas.ts: every
// mutated min/max/regex/default/conditional gets a just-inside-accepts AND a just-outside-
// rejects case, and user-facing issue messages/paths/codes are asserted exactly so a
// StringLiteral/ArrayDeclaration mutation of the addIssue payload can't survive.
//
// Deliberately NOT covered (equivalent mutants — no input can distinguish them):
// - L73 `< 0.001` → `<= 0.001`: the double 0.001 is not a multiple of the ulp of
//   (total - 1.0) near 1, so Math.abs(total - 1) can never equal 0.001 exactly.
// - L133 `new URL(val.trim())` → dropping the trim: `val` is already trimmed by the field's
//   z.string().trim(), and the WHATWG URL parser strips surrounding whitespace anyway.
// - L322 `c.type === "agent"` → `c.type !== "custom_dataset"`: makes the type disjunct
//   always-true, but the managed/posthog members carry no authValue after union stripping,
//   so behavior is unchanged for every reachable input.
// - L619 emptied `catch { }` in the JSON refine: the function then falls through to an
//   implicit `return undefined`, which is falsy — identical rejection to `return false`.

const SHORT_TEXT_MAX = 200;
const MEDIUM_TEXT_MAX = 2_000;
const LONG_TEXT_MAX = 262_144;

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";

const x = (n: number) => "x".repeat(n);

function issueAt(res: ZodSafeParseResult<unknown>, path: (string | number)[]) {
  if (res.success) return undefined;
  return res.error.issues.find(
    (i) => i.path.map(String).join(".") === path.map(String).join(".")
  );
}

function allMessages(res: ZodSafeParseResult<unknown>): string[] {
  return res.success ? [] : res.error.issues.map((i) => i.message);
}

function validAgent(overrides: Record<string, unknown> = {}) {
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

function validCustomDataset(overrides: Record<string, unknown> = {}) {
  return {
    type: "custom_dataset" as const,
    name: "Dataset",
    endpoint: "https://api.example.com/logs",
    authHeader: null,
    authValue: null,
    requestTemplate: '{"since":"{{window_start}}"}',
    responsePath: "rows",
    fieldMap: { userInput: "input", agentOutput: "output" },
    ...overrides,
  };
}

function validPosthog(overrides: Record<string, unknown> = {}) {
  return {
    type: "posthog_dataset" as const,
    name: "PostHog",
    host: "https://us.posthog.com",
    projectId: "12345",
    apiKey: "phx_key",
    hogql: "select properties.input, properties.output from events",
    ...overrides,
  };
}

const validManaged = {
  type: "managed_agent" as const,
  targetModel: "claude-haiku-4-5-20251001" as const,
  prompt: "You are a helpful support agent.",
};

function nModules(n: number) {
  return Array.from({ length: n }, (_, i) => ({ name: `m${i}`, seed: "Seed." }));
}

function templateReferencing(names: string[]): string {
  return JSON.stringify(
    Object.fromEntries([
      ["input", "{{user_input}}"],
      ...names.map((n) => [n, `{{prompt:${n}}}`]),
    ])
  );
}

// ---------- endpointField / posthogHostField ----------

describe("endpoint superRefine issue shape", () => {
  it("rejects an internal endpoint with a custom-code issue carrying the precise reason", () => {
    const res = NewConnectionSchema.safeParse(
      validAgent({ endpoint: "https://localhost/agent" })
    );
    expect(res.success).toBe(false);
    const issue = issueAt(res, ["endpoint"]);
    expect(issue?.code).toBe("custom");
    expect(issue?.message).toBe(ENDPOINT_INTERNAL_MESSAGE);
  });
});

describe("posthog host field", () => {
  it("accepts a posthog.com host", () => {
    const res = NewConnectionSchema.safeParse(validPosthog());
    expect(res.success, res.success ? "" : JSON.stringify(res.error?.issues)).toBe(true);
  });

  it("rejects a public non-PostHog host with the PostHog-host message as a custom issue", () => {
    const res = NewConnectionSchema.safeParse(
      validPosthog({ host: "https://evil.example.com" })
    );
    expect(res.success).toBe(false);
    const issue = issueAt(res, ["host"]);
    expect(issue?.code).toBe("custom");
    expect(issue?.message).toBe(POSTHOG_HOST_MESSAGE);
  });

  it("does not stack the PostHog-host issue on an unparseable URL", () => {
    const res = NewConnectionSchema.safeParse(validPosthog({ host: "not-a-url" }));
    expect(res.success).toBe(false);
    expect(allMessages(res)).not.toContain(POSTHOG_HOST_MESSAGE);
  });
});

// ---------- addPromptRefIssues (shared cross-check) ----------

describe("addPromptRefIssues issue shape (via NewConnectionSchema agent)", () => {
  it("declared-but-unreferenced Module lands a custom issue on requestTemplate", () => {
    const res = NewConnectionSchema.safeParse(
      validAgent({ optimizablePrompts: [{ name: "system", seed: "Answer." }] })
    );
    expect(res.success).toBe(false);
    const issue = issueAt(res, ["requestTemplate"]);
    expect(issue?.code).toBe("custom");
    expect(issue?.path).toEqual(["requestTemplate"]);
    expect(issue?.message).toBe(
      'Declared Module "system" must be referenced as {{prompt:system}} in the request template.'
    );
  });

  it("referenced-but-undeclared Module lands a custom issue on requestTemplate", () => {
    const res = NewConnectionSchema.safeParse(
      validAgent({ requestTemplate: '{"input":"{{user_input}}","g":"{{prompt:ghost}}"}' })
    );
    expect(res.success).toBe(false);
    const issue = issueAt(res, ["requestTemplate"]);
    expect(issue?.code).toBe("custom");
    expect(issue?.path).toEqual(["requestTemplate"]);
    expect(issue?.message).toBe(
      'Request template references {{prompt:ghost}} but no Module "ghost" is declared.'
    );
  });
});

// ---------- NewConnectionSchema: agent member ----------

describe("NewConnectionSchema agent member", () => {
  it("accepts an agent whose declared Modules are unique and referenced", () => {
    const res = NewConnectionSchema.safeParse(
      validAgent({
        optimizablePrompts: [{ name: "system", seed: "Answer." }],
        requestTemplate: '{"input":"{{user_input}}","system":"{{prompt:system}}"}',
      })
    );
    expect(res.success, res.success ? "" : JSON.stringify(res.error?.issues)).toBe(true);
  });

  it("rejects duplicate Module names with the uniqueness message", () => {
    const res = NewConnectionSchema.safeParse(
      validAgent({
        optimizablePrompts: [
          { name: "system", seed: "a" },
          { name: "system", seed: "b" },
        ],
        requestTemplate: '{"input":"{{user_input}}","system":"{{prompt:system}}"}',
      })
    );
    expect(res.success).toBe(false);
    expect(issueAt(res, ["optimizablePrompts"])?.message).toBe("Module names must be unique");
  });

  it("rejects a whitespace-only responsePath (trimmed) with the required message", () => {
    const res = NewConnectionSchema.safeParse(validAgent({ responsePath: "   " }));
    expect(res.success).toBe(false);
    expect(issueAt(res, ["responsePath"])?.message).toBe("Response path is required");
  });

  it("rejects an authValue without an authHeader, on the authHeader path", () => {
    const res = NewConnectionSchema.safeParse(
      validAgent({ authValue: "Bearer sk-123", authHeader: null })
    );
    expect(res.success).toBe(false);
    const issue = issueAt(res, ["authHeader"]);
    expect(issue?.code).toBe("custom");
    expect(issue?.message).toBe(
      "Add an auth header name for the auth value (e.g. Authorization)"
    );
  });

  it("accepts an authValue when the header name is present", () => {
    const res = NewConnectionSchema.safeParse(
      validAgent({ authValue: "Bearer sk-123", authHeader: "Authorization" })
    );
    expect(res.success, res.success ? "" : JSON.stringify(res.error?.issues)).toBe(true);
  });
});

// ---------- NewConnectionSchema: managed_agent member ----------

describe("NewConnectionSchema managed_agent prompt bounds", () => {
  it("rejects a whitespace-only prompt with the required message", () => {
    const res = NewConnectionSchema.safeParse({ ...validManaged, prompt: "   " });
    expect(res.success).toBe(false);
    expect(issueAt(res, ["prompt"])?.message).toBe("Prompt is required");
  });

  it("rejects an over-limit prompt with the max message", () => {
    const res = NewConnectionSchema.safeParse({ ...validManaged, prompt: x(LONG_TEXT_MAX + 1) });
    expect(res.success).toBe(false);
    expect(issueAt(res, ["prompt"])?.message).toBe(
      "Prompt must be at most 262144 characters"
    );
  });
});

// ---------- NewConnectionSchema: custom_dataset member ----------

describe("NewConnectionSchema custom_dataset field bounds", () => {
  it("rejects a whitespace-only query template with the required message", () => {
    const res = NewConnectionSchema.safeParse(validCustomDataset({ requestTemplate: "   " }));
    expect(issueAt(res, ["requestTemplate"])?.message).toBe("Query template is required");
  });

  it("rejects an over-limit query template with the max message", () => {
    const res = NewConnectionSchema.safeParse(
      validCustomDataset({ requestTemplate: x(LONG_TEXT_MAX + 1) })
    );
    expect(issueAt(res, ["requestTemplate"])?.message).toBe(
      "Query template must be at most 262144 characters"
    );
  });

  it("rejects a whitespace-only rows path with the required message", () => {
    const res = NewConnectionSchema.safeParse(validCustomDataset({ responsePath: "   " }));
    expect(issueAt(res, ["responsePath"])?.message).toBe("Rows path is required");
  });

  it("rejects an over-limit rows path with the max message", () => {
    const res = NewConnectionSchema.safeParse(
      validCustomDataset({ responsePath: x(MEDIUM_TEXT_MAX + 1) })
    );
    expect(issueAt(res, ["responsePath"])?.message).toBe(
      "Rows path must be at most 2000 characters"
    );
  });

  it("rejects a custom_dataset authValue without an authHeader", () => {
    const res = NewConnectionSchema.safeParse(
      validCustomDataset({ authValue: "Bearer sk-123", authHeader: null })
    );
    expect(res.success).toBe(false);
    expect(issueAt(res, ["authHeader"])?.code).toBe("custom");
  });
});

// ---------- NewConnectionSchema: posthog_dataset member ----------

describe("NewConnectionSchema posthog_dataset field bounds", () => {
  it("rejects a whitespace-only project id with the required message", () => {
    const res = NewConnectionSchema.safeParse(validPosthog({ projectId: "   " }));
    expect(issueAt(res, ["projectId"])?.message).toBe("PostHog project id is required");
  });

  it("rejects an over-limit project id with the max message", () => {
    const res = NewConnectionSchema.safeParse(validPosthog({ projectId: x(SHORT_TEXT_MAX + 1) }));
    expect(issueAt(res, ["projectId"])?.message).toBe(
      "PostHog project id must be at most 200 characters"
    );
  });

  it("rejects a whitespace-only API key with the required message", () => {
    const res = NewConnectionSchema.safeParse(validPosthog({ apiKey: "   " }));
    expect(issueAt(res, ["apiKey"])?.message).toBe("PostHog API key is required");
  });

  it("rejects an over-limit API key with the max message", () => {
    const res = NewConnectionSchema.safeParse(validPosthog({ apiKey: x(MEDIUM_TEXT_MAX + 1) }));
    expect(issueAt(res, ["apiKey"])?.message).toBe(
      "PostHog API key must be at most 2000 characters"
    );
  });

  it("rejects a whitespace-only HogQL query with the required message", () => {
    const res = NewConnectionSchema.safeParse(validPosthog({ hogql: "   " }));
    expect(issueAt(res, ["hogql"])?.message).toBe("HogQL query is required");
  });

  it("rejects an over-limit HogQL query with the max message", () => {
    const res = NewConnectionSchema.safeParse(validPosthog({ hogql: x(LONG_TEXT_MAX + 1) }));
    expect(issueAt(res, ["hogql"])?.message).toBe(
      "HogQL query must be at most 262144 characters"
    );
  });
});

// ---------- DatasetPreviewSchema ----------

describe("DatasetPreviewSchema custom_dataset", () => {
  function validPreview(overrides: Record<string, unknown> = {}) {
    const { name: _name, ...rest } = validCustomDataset(overrides) as Record<string, unknown>;
    return rest;
  }

  it("accepts a valid custom preview with header + value", () => {
    const res = DatasetPreviewSchema.safeParse(
      validPreview({ authHeader: "Authorization", authValue: "Bearer sk-123" })
    );
    expect(res.success, res.success ? "" : JSON.stringify(res.error?.issues)).toBe(true);
  });

  it("rejects an authValue without an authHeader on the authHeader path", () => {
    const res = DatasetPreviewSchema.safeParse(
      validPreview({ authValue: "Bearer sk-123", authHeader: null })
    );
    expect(res.success).toBe(false);
    const issue = issueAt(res, ["authHeader"]);
    expect(issue?.code).toBe("custom");
    expect(issue?.message).toBe(
      "Add an auth header name for the auth value (e.g. Authorization)"
    );
  });

  it("rejects a whitespace-only query template with the required message", () => {
    const res = DatasetPreviewSchema.safeParse(validPreview({ requestTemplate: "   " }));
    expect(issueAt(res, ["requestTemplate"])?.message).toBe("Query template is required");
  });

  it("rejects an over-limit query template with the max message", () => {
    const res = DatasetPreviewSchema.safeParse(
      validPreview({ requestTemplate: x(LONG_TEXT_MAX + 1) })
    );
    expect(issueAt(res, ["requestTemplate"])?.message).toBe(
      "Query template must be at most 262144 characters"
    );
  });

  it("rejects a whitespace-only rows path with the required message", () => {
    const res = DatasetPreviewSchema.safeParse(validPreview({ responsePath: "   " }));
    expect(issueAt(res, ["responsePath"])?.message).toBe("Rows path is required");
  });

  it("rejects an over-limit rows path with the max message", () => {
    const res = DatasetPreviewSchema.safeParse(
      validPreview({ responsePath: x(MEDIUM_TEXT_MAX + 1) })
    );
    expect(issueAt(res, ["responsePath"])?.message).toBe(
      "Rows path must be at most 2000 characters"
    );
  });
});

describe("DatasetPreviewSchema posthog_dataset", () => {
  function validPreview(overrides: Record<string, unknown> = {}) {
    const { name: _name, ...rest } = validPosthog(overrides) as Record<string, unknown>;
    return rest;
  }

  it("rejects a whitespace-only project id with the required message", () => {
    const res = DatasetPreviewSchema.safeParse(validPreview({ projectId: "   " }));
    expect(issueAt(res, ["projectId"])?.message).toBe("PostHog project id is required");
  });

  it("rejects an over-limit project id with the max message", () => {
    const res = DatasetPreviewSchema.safeParse(validPreview({ projectId: x(SHORT_TEXT_MAX + 1) }));
    expect(issueAt(res, ["projectId"])?.message).toBe(
      "PostHog project id must be at most 200 characters"
    );
  });

  it("rejects a whitespace-only API key with the required message", () => {
    const res = DatasetPreviewSchema.safeParse(validPreview({ apiKey: "   " }));
    expect(issueAt(res, ["apiKey"])?.message).toBe("PostHog API key is required");
  });

  it("rejects an over-limit API key with the max message", () => {
    const res = DatasetPreviewSchema.safeParse(validPreview({ apiKey: x(MEDIUM_TEXT_MAX + 1) }));
    expect(issueAt(res, ["apiKey"])?.message).toBe(
      "PostHog API key must be at most 2000 characters"
    );
  });

  it("rejects a whitespace-only HogQL query with the required message", () => {
    const res = DatasetPreviewSchema.safeParse(validPreview({ hogql: "   " }));
    expect(issueAt(res, ["hogql"])?.message).toBe("HogQL query is required");
  });

  it("rejects an over-limit HogQL query with the max message", () => {
    const res = DatasetPreviewSchema.safeParse(validPreview({ hogql: x(LONG_TEXT_MAX + 1) }));
    expect(issueAt(res, ["hogql"])?.message).toBe(
      "HogQL query must be at most 262144 characters"
    );
  });
});

// ---------- ScheduleInputRowSchema ----------

describe("ScheduleInputRowSchema.userInput bounds", () => {
  it("rejects a whitespace-only user input with the required message", () => {
    const res = ScheduleInputRowSchema.safeParse({ userInput: "   " });
    expect(issueAt(res, ["userInput"])?.message).toBe("User input is required");
  });

  it("rejects an over-limit user input with the max message", () => {
    const res = ScheduleInputRowSchema.safeParse({ userInput: x(LONG_TEXT_MAX + 1) });
    expect(issueAt(res, ["userInput"])?.message).toBe(
      "User input must be at most 262144 characters"
    );
  });
});

// ---------- ScheduleCadenceSchema ----------

describe("ScheduleCadenceSchema", () => {
  const base = { frequency: "daily" as const, localHour: 9, timezone: "UTC" };

  it("rejects an empty timezone with the required message", () => {
    const res = ScheduleCadenceSchema.safeParse({ ...base, timezone: "" });
    expect(issueAt(res, ["timezone"])?.message).toBe("Timezone is required");
  });

  it("rejects an over-limit timezone with the invalid message", () => {
    const res = ScheduleCadenceSchema.safeParse({ ...base, timezone: x(SHORT_TEXT_MAX + 1) });
    expect(issueAt(res, ["timezone"])?.message).toBe("Invalid timezone");
  });

  it("weekly without daysOfWeek fails on daysOfWeek", () => {
    const res = ScheduleCadenceSchema.safeParse({ ...base, frequency: "weekly" });
    expect(res.success).toBe(false);
    const issue = issueAt(res, ["daysOfWeek"]);
    expect(issue?.code).toBe("custom");
    expect(issue?.message).toBe("Pick at least one day");
  });

  it("weekly with an empty daysOfWeek array fails on daysOfWeek", () => {
    const res = ScheduleCadenceSchema.safeParse({ ...base, frequency: "weekly", daysOfWeek: [] });
    expect(res.success).toBe(false);
    expect(issueAt(res, ["daysOfWeek"])?.message).toBe("Pick at least one day");
  });

  it("weekly with one day accepted", () => {
    const res = ScheduleCadenceSchema.safeParse({ ...base, frequency: "weekly", daysOfWeek: [1] });
    expect(res.success, res.success ? "" : JSON.stringify(res.error?.issues)).toBe(true);
  });

  it("monthly without dayOfMonth fails on dayOfMonth", () => {
    const res = ScheduleCadenceSchema.safeParse({ ...base, frequency: "monthly" });
    expect(res.success).toBe(false);
    const issue = issueAt(res, ["dayOfMonth"]);
    expect(issue?.code).toBe("custom");
    expect(issue?.message).toBe("Pick a day of the month");
  });

  it("monthly with a dayOfMonth accepted", () => {
    const res = ScheduleCadenceSchema.safeParse({ ...base, frequency: "monthly", dayOfMonth: 15 });
    expect(res.success, res.success ? "" : JSON.stringify(res.error?.issues)).toBe(true);
  });
});

// ---------- CreateScheduleSchema ----------

describe("CreateScheduleSchema", () => {
  function validSchedule(overrides: Record<string, unknown> = {}) {
    return {
      name: "Nightly",
      rubricId: UUID,
      connectionId: UUID2,
      cadence: { frequency: "daily" as const, localHour: 9, timezone: "UTC" },
      ...overrides,
    };
  }

  it("rejects a whitespace-only name with the required message", () => {
    const res = CreateScheduleSchema.safeParse(validSchedule({ name: "   " }));
    expect(issueAt(res, ["name"])?.message).toBe("Schedule name is required");
  });

  it("rejects an over-limit name with the max message", () => {
    const res = CreateScheduleSchema.safeParse(validSchedule({ name: x(SHORT_TEXT_MAX + 1) }));
    expect(issueAt(res, ["name"])?.message).toBe(
      "Schedule name must be at most 200 characters"
    );
  });

  it("rejects a non-uuid rubricId with the select message", () => {
    const res = CreateScheduleSchema.safeParse(validSchedule({ rubricId: "not-a-uuid" }));
    expect(issueAt(res, ["rubricId"])?.message).toBe("Select a rubric");
  });

  it('accepts an explicit evalType of "tabular" and defaults it when omitted', () => {
    const explicit = CreateScheduleSchema.safeParse(validSchedule({ evalType: "tabular" }));
    expect(explicit.success, explicit.success ? "" : JSON.stringify(explicit.error?.issues)).toBe(true);
    const omitted = CreateScheduleSchema.safeParse(validSchedule());
    expect(omitted.success).toBe(true);
    expect(omitted.success ? omitted.data.evalType : undefined).toBe("tabular");
  });

  it("defaults inputs to an empty array and enabled to true when omitted", () => {
    const res = CreateScheduleSchema.safeParse(validSchedule());
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.inputs).toEqual([]);
      expect(res.data.enabled).toBe(true);
    }
  });

  it("rejects more than 1000 input rows with the max message", () => {
    const inputs = Array.from({ length: 1_001 }, (_, i) => ({ userInput: `row ${i}` }));
    const res = CreateScheduleSchema.safeParse(validSchedule({ inputs }));
    expect(issueAt(res, ["inputs"])?.message).toBe("At most 1000 input rows");
  });

  it("rejects a windowMinutes past one year with the max message", () => {
    const res = CreateScheduleSchema.safeParse(validSchedule({ windowMinutes: 525_601 }));
    expect(issueAt(res, ["windowMinutes"])?.message).toBe(
      "At most 525600 minutes (1 year)"
    );
  });

  it("rejects a maxRows past 10000 with the max message", () => {
    const res = CreateScheduleSchema.safeParse(validSchedule({ maxRows: 10_001 }));
    expect(issueAt(res, ["maxRows"])?.message).toBe("At most 10000 rows");
  });

  it("requires a connection: neither connectionId nor newConnection fails on connectionId", () => {
    const res = CreateScheduleSchema.safeParse(validSchedule({ connectionId: undefined }));
    expect(res.success).toBe(false);
    const issue = issueAt(res, ["connectionId"]);
    expect(issue?.code).toBe("custom");
    expect(issue?.path).toEqual(["connectionId"]);
    expect(issue?.message).toBe("Select or create a System connection");
  });

  it("a new dataset connection requires both windowMinutes and maxRows", () => {
    const res = CreateScheduleSchema.safeParse(
      validSchedule({ connectionId: undefined, newConnection: validCustomDataset() })
    );
    expect(res.success).toBe(false);
    const windowIssue = issueAt(res, ["windowMinutes"]);
    expect(windowIssue?.code).toBe("custom");
    expect(windowIssue?.path).toEqual(["windowMinutes"]);
    expect(windowIssue?.message).toBe("Set a lookback window");
    const rowsIssue = issueAt(res, ["maxRows"]);
    expect(rowsIssue?.code).toBe("custom");
    expect(rowsIssue?.path).toEqual(["maxRows"]);
    expect(rowsIssue?.message).toBe("Set a maximum row count");
  });

  it("a new dataset connection with windowMinutes and maxRows is accepted", () => {
    const res = CreateScheduleSchema.safeParse(
      validSchedule({
        connectionId: undefined,
        newConnection: validCustomDataset(),
        windowMinutes: 60,
        maxRows: 100,
      })
    );
    expect(res.success, res.success ? "" : JSON.stringify(res.error?.issues)).toBe(true);
  });

  it("a new agent connection with no inputs fails on inputs", () => {
    const res = CreateScheduleSchema.safeParse(
      validSchedule({ connectionId: undefined, newConnection: validAgent() })
    );
    expect(res.success).toBe(false);
    expect(issueAt(res, ["inputs"])?.message).toBe("At least one input row is required");
  });

  it("a new agent connection with one input row is accepted", () => {
    const res = CreateScheduleSchema.safeParse(
      validSchedule({
        connectionId: undefined,
        newConnection: validAgent(),
        inputs: [{ userInput: "hello" }],
      })
    );
    expect(res.success, res.success ? "" : JSON.stringify(res.error?.issues)).toBe(true);
  });
});

// ---------- OptimizationInstanceSchema ----------

describe("OptimizationInstanceSchema.userInput bounds", () => {
  it("rejects a whitespace-only user input with the required message", () => {
    const res = OptimizationInstanceSchema.safeParse({ userInput: "   " });
    expect(issueAt(res, ["userInput"])?.message).toBe("User input is required");
  });

  it("rejects an over-limit user input with the max message", () => {
    const res = OptimizationInstanceSchema.safeParse({ userInput: x(LONG_TEXT_MAX + 1) });
    expect(issueAt(res, ["userInput"])?.message).toBe(
      "User input must be at most 262144 characters"
    );
  });
});

// ---------- InstancesSourceSchema messages ----------

describe("InstancesSourceSchema messages", () => {
  it("over-cap inline instances carry the v1 cap message", () => {
    const instances = Array.from({ length: MAX_OPTIMIZATION_INSTANCES + 1 }, (_, i) => ({
      userInput: `Q${i}`,
    }));
    const res = InstancesSourceSchema.safeParse({ type: "inline", instances });
    expect(issueAt(res, ["instances"])?.message).toBe(
      `Up to ${MAX_OPTIMIZATION_INSTANCES} instances in v1`
    );
  });

  it("a non-uuid dataset connectionId carries the select message", () => {
    const res = InstancesSourceSchema.safeParse({
      type: "dataset_snapshot",
      connectionId: "not-a-uuid",
      windowMinutes: 1440,
    });
    expect(issueAt(res, ["connectionId"])?.message).toBe("Select a dataset connection");
  });

  it("a non-positive windowMinutes carries the lookback message", () => {
    const res = InstancesSourceSchema.safeParse({
      type: "dataset_snapshot",
      connectionId: UUID,
      windowMinutes: 0,
    });
    expect(issueAt(res, ["windowMinutes"])?.message).toBe("Set a lookback window");
  });

  it("an over-ceiling windowMinutes carries the too-long message", () => {
    const res = InstancesSourceSchema.safeParse({
      type: "dataset_snapshot",
      connectionId: UUID,
      windowMinutes: DATASET_SNAPSHOT_MAX_WINDOW_MINUTES + 1,
    });
    expect(issueAt(res, ["windowMinutes"])?.message).toBe("Lookback window is too long");
  });

  it("a non-uuid evalRunId carries the select message", () => {
    const res = InstancesSourceSchema.safeParse({ type: "eval_run", evalRunId: "not-a-uuid" });
    expect(issueAt(res, ["evalRunId"])?.message).toBe("Select an eval run");
  });
});

// ---------- NewOptimizationConnectionSchema ----------

describe("NewOptimizationConnectionSchema module bounds", () => {
  it("an agent with zero Modules and a ref-free template fails with the declare message", () => {
    // The template carries no {{prompt:*}} refs, so ONLY the min(1) on the extended
    // optimizablePrompts can reject it — a mutant restoring the base optional/default
    // shape would let it pass.
    const res = NewOptimizationConnectionSchema.safeParse(
      validAgent({ optimizablePrompts: [], requestTemplate: '{"input":"{{user_input}}"}' })
    );
    expect(res.success).toBe(false);
    expect(issueAt(res, ["optimizablePrompts"])?.message).toBe("Declare at least one Module");
  });

  it("accepts exactly 20 Modules and rejects 21 with the max message", () => {
    const twenty = nModules(20);
    const ok = NewOptimizationConnectionSchema.safeParse(
      validAgent({
        optimizablePrompts: twenty,
        requestTemplate: templateReferencing(twenty.map((m) => m.name)),
      })
    );
    expect(ok.success, ok.success ? "" : JSON.stringify(ok.error?.issues)).toBe(true);

    const twentyOne = nModules(21);
    const res = NewOptimizationConnectionSchema.safeParse(
      validAgent({
        optimizablePrompts: twentyOne,
        requestTemplate: templateReferencing(twentyOne.map((m) => m.name)),
      })
    );
    expect(res.success).toBe(false);
    expect(issueAt(res, ["optimizablePrompts"])?.message).toBe("At most 20 modules");
  });

  it("rejects duplicate Module names with the uniqueness message", () => {
    const res = NewOptimizationConnectionSchema.safeParse(
      validAgent({
        optimizablePrompts: [
          { name: "system", seed: "a" },
          { name: "system", seed: "b" },
        ],
        requestTemplate: '{"system":"{{prompt:system}}"}',
      })
    );
    expect(res.success).toBe(false);
    expect(issueAt(res, ["optimizablePrompts"])?.message).toBe("Module names must be unique");
  });

  it("an authValue without an authHeader fails on the authHeader path with the full message", () => {
    const res = NewOptimizationConnectionSchema.safeParse(
      validAgent({
        optimizablePrompts: [{ name: "system", seed: "a" }],
        requestTemplate: '{"input":"{{user_input}}","system":"{{prompt:system}}"}',
        authValue: "Bearer sk-123",
        authHeader: null,
      })
    );
    expect(res.success).toBe(false);
    const issue = issueAt(res, ["authHeader"]);
    expect(issue?.code).toBe("custom");
    expect(issue?.path).toEqual(["authHeader"]);
    expect(issue?.message).toBe(
      "Add an auth header name for the auth value (e.g. Authorization)"
    );
  });
});

// ---------- UpdateConnectionModulesSchema ----------

describe("UpdateConnectionModulesSchema bounds", () => {
  function valid(overrides: Record<string, unknown> = {}) {
    return {
      connectionId: UUID2,
      requestTemplate: '{"input":"{{user_input}}","system":"{{prompt:system}}"}',
      modules: [{ name: "system", seed: "Answer helpfully." }],
      ...overrides,
    };
  }

  it("rejects a non-uuid connectionId with the invalid message", () => {
    const res = UpdateConnectionModulesSchema.safeParse(valid({ connectionId: "nope" }));
    expect(issueAt(res, ["connectionId"])?.message).toBe("Invalid connection");
  });

  it("rejects a whitespace-only request template with the required message", () => {
    const res = UpdateConnectionModulesSchema.safeParse(
      valid({ requestTemplate: "   ", modules: [] })
    );
    expect(res.success).toBe(false);
    expect(allMessages(res)).toContain("Request template is required");
  });

  it("rejects an over-limit request template with the max message", () => {
    // A valid JSON string literal so the only length-side failure is the max bound.
    const res = UpdateConnectionModulesSchema.safeParse(
      valid({ requestTemplate: `"${x(LONG_TEXT_MAX)}"`, modules: [] })
    );
    expect(res.success).toBe(false);
    expect(allMessages(res)).toContain("Request template must be at most 262144 characters");
  });

  it("rejects 21 modules with the max message", () => {
    const twentyOne = nModules(21);
    const res = UpdateConnectionModulesSchema.safeParse(
      valid({
        modules: twentyOne,
        requestTemplate: templateReferencing(twentyOne.map((m) => m.name)),
      })
    );
    expect(res.success).toBe(false);
    expect(issueAt(res, ["modules"])?.message).toBe("At most 20 modules");
  });
});

// ---------- UpdateManagedConnectionSchema ----------

describe("UpdateManagedConnectionSchema", () => {
  function valid(overrides: Record<string, unknown> = {}) {
    return {
      connectionId: UUID2,
      prompt: "You are a helpful support agent.",
      targetModel: "claude-haiku-4-5-20251001",
      ...overrides,
    };
  }

  it("accepts a valid managed-connection update", () => {
    const res = UpdateManagedConnectionSchema.safeParse(valid());
    expect(res.success, res.success ? "" : JSON.stringify(res.error?.issues)).toBe(true);
  });

  it("rejects a non-uuid connectionId with the invalid message", () => {
    const res = UpdateManagedConnectionSchema.safeParse(valid({ connectionId: "nope" }));
    expect(issueAt(res, ["connectionId"])?.message).toBe("Invalid connection");
  });

  it("rejects a whitespace-only prompt (trimmed) with the required message", () => {
    const res = UpdateManagedConnectionSchema.safeParse(valid({ prompt: "   " }));
    expect(issueAt(res, ["prompt"])?.message).toBe("Prompt is required");
  });

  it("rejects an over-limit prompt with the max message", () => {
    const res = UpdateManagedConnectionSchema.safeParse(valid({ prompt: x(LONG_TEXT_MAX + 1) }));
    expect(issueAt(res, ["prompt"])?.message).toBe(
      "Prompt must be at most 262144 characters"
    );
  });
});

// ---------- CreateOptimizationRunSchema ----------

describe("CreateOptimizationRunSchema field bounds", () => {
  function validRun(overrides: Record<string, unknown> = {}) {
    return {
      connectionId: UUID2,
      rubricId: UUID,
      instancesSource: { type: "inline" as const, instances: [{ userInput: "Q" }] },
      budgetRollouts: 30,
      ...overrides,
    };
  }

  it("rejects a non-uuid connectionId with the select message", () => {
    const res = CreateOptimizationRunSchema.safeParse(validRun({ connectionId: "not-a-uuid" }));
    expect(issueAt(res, ["connectionId"])?.message).toBe("Select an agent connection");
  });

  it("rejects a non-uuid rubricId with the select message", () => {
    const res = CreateOptimizationRunSchema.safeParse(validRun({ rubricId: "not-a-uuid" }));
    expect(issueAt(res, ["rubricId"])?.message).toBe("Select a rubric");
  });

  it('accepts an explicit evalType of "tabular" and defaults it when omitted', () => {
    const explicit = CreateOptimizationRunSchema.safeParse(validRun({ evalType: "tabular" }));
    expect(explicit.success, explicit.success ? "" : JSON.stringify(explicit.error?.issues)).toBe(true);
    const omitted = CreateOptimizationRunSchema.safeParse(validRun());
    expect(omitted.success).toBe(true);
    expect(omitted.success ? omitted.data.evalType : undefined).toBe("tabular");
  });

  it("rejects a non-positive rollout budget with the budget message", () => {
    const res = CreateOptimizationRunSchema.safeParse(validRun({ budgetRollouts: 0 }));
    expect(issueAt(res, ["budgetRollouts"])?.message).toBe("Set a rollout budget");
  });

  it("rejects a whitespace-only reflectModel (trimmed to empty)", () => {
    const res = CreateOptimizationRunSchema.safeParse(validRun({ reflectModel: "   " }));
    expect(res.success).toBe(false);
    expect(issueAt(res, ["reflectModel"])).toBeDefined();
  });

  it("the connection xor issue lands on connectionId with the exact copy", () => {
    const res = CreateOptimizationRunSchema.safeParse(validRun({ connectionId: undefined }));
    expect(res.success).toBe(false);
    const issue = issueAt(res, ["connectionId"]);
    expect(issue?.code).toBe("custom");
    expect(issue?.path).toEqual(["connectionId"]);
    expect(issue?.message).toBe("Provide either an existing agent connection or a new one.");
  });
});

// ---------- AccessCodeSchema ----------

describe("AccessCodeSchema", () => {
  it("accepts a code exactly at the 200-char limit", () => {
    expect(AccessCodeSchema.safeParse(x(SHORT_TEXT_MAX)).success).toBe(true);
  });

  it("rejects a whitespace-only code (trimmed) with the enter message", () => {
    const res = AccessCodeSchema.safeParse("   ");
    expect(res.success).toBe(false);
    expect(allMessages(res)).toContain("Enter your access code");
  });

  it("rejects an over-limit code with the max message", () => {
    const res = AccessCodeSchema.safeParse(x(SHORT_TEXT_MAX + 1));
    expect(res.success).toBe(false);
    expect(allMessages(res)).toContain("Access code must be at most 200 characters");
  });
});
