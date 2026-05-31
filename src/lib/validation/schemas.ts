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

// An agent-kind Connection: an endpoint Baseline invokes per input row. The request
// template adapts to the customer's existing API; response_path locates agent_output.
export const NewConnectionSchema = z
  .object({
    name: z.string().trim().min(1, "Connection name is required").max(200),
    endpoint: z
      .string()
      .trim()
      .url("Enter a valid URL (https://…)")
      .refine(isAllowedEndpointUrl, ENDPOINT_HTTPS_MESSAGE),
    authHeader: z.string().trim().optional().nullable(),
    authValue: z.string().optional().nullable(),
    requestTemplate: z.string().trim().min(1, "Request template is required"),
    responsePath: z.string().trim().min(1, "Response path is required"),
  })
  // A credential needs a header to carry it; otherwise the worker stores the secret
  // but never sends it. (The reverse — a header with no value — is fine: no auth sent.)
  .refine((c) => !c.authValue || Boolean(c.authHeader), {
    message: "Add an auth header name for the auth value (e.g. Authorization)",
    path: ["authHeader"],
  });

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
    inputs: z.array(ScheduleInputRowSchema).min(1, "At least one input row is required"),
    cadence: ScheduleCadenceSchema,
    enabled: z.boolean().default(true),
    notificationEmails: z.array(z.string().email()).optional(),
  })
  .refine((s) => Boolean(s.connectionId) || Boolean(s.newConnection), {
    message: "Select or create a System connection",
    path: ["connectionId"],
  });
