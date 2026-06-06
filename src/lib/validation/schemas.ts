import { z } from "zod";
import { isAllowedEndpointUrl, ENDPOINT_HTTPS_MESSAGE } from "@/lib/connections/endpoint";

// ---------- Rubric ----------

export const CriterionSchema = z.object({
  name: z.string().min(1, "Criterion name is required"),
  weight: z.number().min(0).max(1),
  steps: z
    .array(z.string().min(1, "Step cannot be empty"))
    .min(1, "At least one step is required"),
});

export const RubricSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  scenario_description: z.string().min(1, "Scenario description is required"),
  expected_outcome: z.string().min(1, "Expected outcome is required"),
  evaluation_mode: z.enum(["conversational", "prompt_response"]),
  grounding_context: z.string().nullable().optional(),
  criteria: z
    .array(CriterionSchema)
    .min(1, "At least one criterion is required")
    .refine(
      (criteria) => {
        const total = criteria.reduce((sum, c) => sum + c.weight, 0);
        return Math.abs(total - 1.0) < 0.001;
      },
      { message: "Criterion weights must sum to 1.0" }
    ),
});

// ---------- Eval run ----------

export const EvalRunRowSchema = z.object({
  userInput: z.string().trim().min(1, "User input is required"),
  agentOutput: z.string().trim().min(1, "Agent output is required"),
  expectedOutput: z.string().optional(),
  retrievalContext: z.string().optional(),
});

export const EvalRunInputSchema = z.object({
  rubricId: z.string().min(1, "Select a rubric"),
  rows: z
    .array(EvalRunRowSchema)
    .min(1, "At least one input row is required"),
});

// ---------- Connection ----------

const endpointField = z
  .string()
  .trim()
  .url("Enter a valid URL (https://…)")
  .refine(isAllowedEndpointUrl, ENDPOINT_HTTPS_MESSAGE);

const connectionName = z.string().trim().min(1, "Connection name is required").max(200);

// Maps each fetched dataset row's required fields to our columns (custom dataset only).
export const FieldMapSchema = z.object({
  userInput: z.string().trim().min(1, "Map a path to user input"),
  agentOutput: z.string().trim().min(1, "Map a path to agent output"),
});

// A named optimizable prompt (Module) the optimization loop can tune. `name` is the
// token used in {{prompt:<name>}} placeholders; `seed` is the starting prompt rendered
// when no Candidate overrides it.
export const OptimizablePromptSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Module name is required")
    .regex(/^[A-Za-z0-9_-]+$/, "Use letters, digits, hyphens, or underscores"),
  seed: z.string().trim().min(1, "Seed prompt is required"),
});

// agent: an endpoint Baseline invokes per input row to produce agent_output live.
const AgentConnectionSchema = z.object({
  type: z.literal("agent"),
  name: connectionName,
  endpoint: endpointField,
  authHeader: z.string().trim().optional().nullable(),
  authValue: z.string().optional().nullable(),
  requestTemplate: z.string().trim().min(1, "Request template is required"),
  responsePath: z.string().trim().min(1, "Response path is required"),
  // Optional optimizable prompt Modules. Empty for the {{user_input}}-only case.
  optimizablePrompts: z
    .array(OptimizablePromptSchema)
    .optional()
    .default([])
    .refine(
      (modules) => new Set(modules.map((m) => m.name)).size === modules.length,
      "Module names must be unique"
    ),
});

// custom dataset: GET a customer log/trace API; map each returned row via field_map.
const CustomDatasetConnectionSchema = z.object({
  type: z.literal("custom_dataset"),
  name: connectionName,
  endpoint: endpointField,
  authHeader: z.string().trim().optional().nullable(),
  authValue: z.string().optional().nullable(),
  requestTemplate: z.string().trim().min(1, "Query template is required"),
  responsePath: z.string().trim().min(1, "Rows path is required"),
  fieldMap: FieldMapSchema,
});

// posthog dataset: run a HogQL query whose columns are aliased to our field names.
const PosthogDatasetConnectionSchema = z.object({
  type: z.literal("posthog_dataset"),
  name: connectionName,
  host: endpointField,
  projectId: z.string().trim().min(1, "PostHog project id is required"),
  apiKey: z.string().trim().min(1, "PostHog API key is required"),
  hogql: z.string().trim().min(1, "HogQL query is required"),
});

// A Connection is one of three concrete types (agent / custom dataset / posthog dataset).
export const NewConnectionSchema = z
  .discriminatedUnion("type", [
    AgentConnectionSchema,
    CustomDatasetConnectionSchema,
    PosthogDatasetConnectionSchema,
  ])
  // A credential needs a header to carry it; otherwise the worker stores the secret
  // but never sends it. (The reverse — a header with no value — is fine: no auth sent.)
  .superRefine((c, ctx) => {
    if ((c.type === "agent" || c.type === "custom_dataset") && c.authValue && !c.authHeader) {
      ctx.addIssue({
        code: "custom",
        path: ["authHeader"],
        message: "Add an auth header name for the auth value (e.g. Authorization)",
      });
    }
  });

export function isDatasetConnectionType(type: string): boolean {
  return type === "custom_dataset" || type === "posthog_dataset";
}

// ---------- Schedule ----------

export const ScheduleInputRowSchema = z.object({
  userInput: z.string().trim().min(1, "User input is required"),
  expectedOutput: z.string().optional().nullable(),
  retrievalContext: z.string().optional().nullable(),
});

export const ScheduleCadenceSchema = z
  .object({
    frequency: z.enum(["hourly", "daily", "weekly", "monthly"]),
    localHour: z.number().int().min(0).max(23).nullable().optional(),
    daysOfWeek: z.array(z.number().int().min(1).max(7)).optional(),
    dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
    timezone: z.string().min(1, "Timezone is required"),
  })
  .superRefine((c, ctx) => {
    if (c.frequency !== "hourly" && c.localHour == null) {
      ctx.addIssue({ code: "custom", path: ["localHour"], message: "Pick an hour" });
    }
    if (c.frequency === "weekly" && (!c.daysOfWeek || c.daysOfWeek.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["daysOfWeek"], message: "Pick at least one day" });
    }
    if (c.frequency === "monthly" && c.dayOfMonth == null) {
      ctx.addIssue({ code: "custom", path: ["dayOfMonth"], message: "Pick a day of the month" });
    }
  });

export const CreateScheduleSchema = z
  .object({
    name: z.string().trim().min(1, "Schedule name is required").max(200),
    description: z.string().optional().nullable(),
    rubricId: z.string().uuid("Select a rubric"),
    evalType: z.literal("tabular").default("tabular"),
    connectionId: z.string().uuid().optional().nullable(),
    newConnection: NewConnectionSchema.optional().nullable(),
    // agent kind: a fixed input set. dataset kind: none (rows come from the source).
    inputs: z.array(ScheduleInputRowSchema).optional().default([]),
    // dataset kind: how much history and how many rows to pull each fire.
    windowMinutes: z.number().int().positive().nullable().optional(),
    maxRows: z.number().int().positive().nullable().optional(),
    cadence: ScheduleCadenceSchema,
    enabled: z.boolean().default(true),
    notificationEmails: z.array(z.string().email()).optional(),
  })
  // Kind-specific requirements are enforced here when a NEW connection is supplied (its
  // type reveals the kind). For an EXISTING connection the kind isn't visible to the
  // schema, so the server action resolves it and re-checks. See createSchedule.
  .superRefine((s, ctx) => {
    if (!s.connectionId && !s.newConnection) {
      ctx.addIssue({
        code: "custom",
        path: ["connectionId"],
        message: "Select or create a System connection",
      });
    }
    if (s.newConnection) {
      if (isDatasetConnectionType(s.newConnection.type)) {
        if (s.windowMinutes == null) {
          ctx.addIssue({ code: "custom", path: ["windowMinutes"], message: "Set a lookback window" });
        }
        if (s.maxRows == null) {
          ctx.addIssue({ code: "custom", path: ["maxRows"], message: "Set a maximum row count" });
        }
      } else if (s.inputs.length === 0) {
        ctx.addIssue({ code: "custom", path: ["inputs"], message: "At least one input row is required" });
      }
    }
  });

// ---------- Optimization run ----------

// One frozen input instance every Candidate is scored against. Mirrors a schedule input
// row; expected_output / retrieval_context are optional context for the judge.
export const OptimizationInstanceSchema = z.object({
  userInput: z.string().trim().min(1, "User input is required"),
  expectedOutput: z.string().optional().nullable(),
  retrievalContext: z.string().optional().nullable(),
});

// Start a manual, one-shot Optimization Run (D11) over an agent Connection's declared
// Modules. The instance set is capped (D9, v1 sizing) and frozen at run start.
export const CreateOptimizationRunSchema = z.object({
  connectionId: z.string().uuid("Select an agent connection"),
  rubricId: z.string().uuid("Select a rubric"),
  evalType: z.literal("tabular").default("tabular"),
  instances: z
    .array(OptimizationInstanceSchema)
    .min(1, "At least one input instance is required")
    .max(50, "Up to 50 instances in v1"),
  budgetRollouts: z.number().int().positive("Set a rollout budget").max(2000),
  maxIters: z.number().int().positive().max(200).default(20),
  plateauPatience: z.number().int().positive().nullable().optional(),
  reflectModel: z.string().trim().min(1).optional(),
});

// ---------- Email ----------

// A single normalized email field. Lowercased + trimmed so uniqueness and match
// comparisons are case-insensitive. Reused by invitations and the account
// email-change flow.
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address");

// ---------- Invitation ----------

// An org admin invites a person by email.
export const InviteSchema = z.object({
  email: EmailSchema,
});
