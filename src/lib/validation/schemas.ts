import { z } from "zod";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { endpointUrlError } from "@/lib/connections/endpoint";
import { isAllowedPosthogHostUrl, POSTHOG_HOST_MESSAGE } from "@/lib/connections/posthog-host";
import { extractPromptRefs } from "@/lib/optimization/prompt-refs";

// ---------- Free-text length bounds ----------
//
// Every free-text string a tenant can submit gets an explicit upper bound so a single
// authenticated request can't inflate a stored row with a multi-MB blob (storage/DoS
// hardening — #224). The limits are single-sourced here rather than sprinkled as magic
// numbers, and sized to comfortably exceed any legitimate input (names, prose, prompt
// templates, eval transcripts) while rejecting pathological sizes. The e2e seed fixtures
// and normal usage stay well under these.
//
//   SHORT  — names and short identifiers/labels (a few hundred chars).
//   MEDIUM — a paragraph or two of prose: descriptions, scenarios, expected outcomes,
//            response/field-map paths, header names/values, model ids.
//   LONG   — large free-text blobs (~64 KB): grounding context, prompt seeds, request
//            templates, HogQL queries, and the eval-row text fields (user/agent/expected
//            output, retrieval context) that may carry whole transcripts or documents.
const SHORT_TEXT_MAX = 200;
const MEDIUM_TEXT_MAX = 2_000;
const LONG_TEXT_MAX = 65_536;

// ---------- Rubric ----------

export const CriterionSchema = z.object({
  name: z.string().min(1, "Criterion name is required").max(SHORT_TEXT_MAX, "Criterion name must be at most 200 characters"),
  weight: z.number().min(0).max(1),
  steps: z
    .array(
      z
        .string()
        .min(1, "Step cannot be empty")
        .max(MEDIUM_TEXT_MAX, "Step must be at most 2000 characters")
    )
    .min(1, "At least one step is required"),
});

export const RubricSchema = z.object({
  name: z.string().min(1, "Name is required").max(SHORT_TEXT_MAX, "Name must be at most 200 characters"),
  scenario_description: z
    .string()
    .min(1, "Scenario description is required")
    .max(LONG_TEXT_MAX, "Scenario description must be at most 65536 characters"),
  expected_outcome: z
    .string()
    .min(1, "Expected outcome is required")
    .max(LONG_TEXT_MAX, "Expected outcome must be at most 65536 characters"),
  evaluation_mode: z.enum(["conversational", "prompt_response"]),
  grounding_context: z
    .string()
    .max(LONG_TEXT_MAX, "Grounding context must be at most 65536 characters")
    .nullable()
    .optional(),
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
  userInput: z
    .string()
    .trim()
    .min(1, "User input is required")
    .max(LONG_TEXT_MAX, "User input must be at most 65536 characters"),
  agentOutput: z
    .string()
    .trim()
    .min(1, "Agent output is required")
    .max(LONG_TEXT_MAX, "Agent output must be at most 65536 characters"),
  expectedOutput: z
    .string()
    .max(LONG_TEXT_MAX, "Expected output must be at most 65536 characters")
    .optional(),
  retrievalContext: z
    .string()
    .max(LONG_TEXT_MAX, "Retrieval context must be at most 65536 characters")
    .optional(),
});

export const EvalRunInputSchema = z.object({
  rubricId: z.string().min(1, "Select a rubric").max(SHORT_TEXT_MAX, "Invalid rubric id"),
  rows: z
    .array(EvalRunRowSchema)
    .min(1, "At least one input row is required"),
});

// ---------- Connection ----------

const endpointField = z
  .string()
  .trim()
  .max(MEDIUM_TEXT_MAX, "URL must be at most 2000 characters")
  .url("Enter a valid URL (https://…)")
  // Reject obviously-internal endpoints at save time with a precise reason (bad scheme,
  // embedded credentials, localhost/.internal/.local, or a private/reserved IP literal).
  // The worker re-validates at fetch time; this is the first gate + UX. See endpointUrlError.
  .superRefine((val, ctx) => {
    const error = endpointUrlError(val);
    if (error) ctx.addIssue({ code: "custom", message: error });
  });

// A PostHog dataset's host is an endpoint (so it inherits the scheme/internal-address rules)
// AND must be a PostHog host (#221), so the adapter can't be aimed at an arbitrary public
// host. Chained .superRefine still runs even when an earlier check (e.g. .url()) failed, so we
// skip the host check for an unparseable value — otherwise a malformed URL would stack a
// redundant "must be a posthog.com address" issue on top of the "Enter a valid URL" one.
const posthogHostField = endpointField.superRefine((val, ctx) => {
  let parseable = true;
  try {
    new URL(val.trim());
  } catch {
    parseable = false;
  }
  if (parseable && !isAllowedPosthogHostUrl(val)) {
    ctx.addIssue({ code: "custom", message: POSTHOG_HOST_MESSAGE });
  }
});

const connectionName = z
  .string()
  .trim()
  .min(1, "Connection name is required")
  .max(SHORT_TEXT_MAX, "Connection name must be at most 200 characters");

// An optional auth credential: the header NAME (short) and its VALUE (a token/secret, which
// can be longer but is never a multi-MB blob — MEDIUM is plenty).
const authHeaderField = z
  .string()
  .trim()
  .max(SHORT_TEXT_MAX, "Auth header name must be at most 200 characters")
  .optional()
  .nullable();
const authValueField = z
  .string()
  .max(MEDIUM_TEXT_MAX, "Auth value must be at most 2000 characters")
  .optional()
  .nullable();

// Maps each fetched dataset row's required fields to our columns (custom dataset only).
export const FieldMapSchema = z.object({
  userInput: z
    .string()
    .trim()
    .min(1, "Map a path to user input")
    .max(MEDIUM_TEXT_MAX, "User input path must be at most 2000 characters"),
  agentOutput: z
    .string()
    .trim()
    .min(1, "Map a path to agent output")
    .max(MEDIUM_TEXT_MAX, "Agent output path must be at most 2000 characters"),
});

// A named optimizable prompt (Module) the optimization loop can tune. `name` is the
// token used in {{prompt:<name>}} placeholders; `seed` is the starting prompt rendered
// when no Candidate overrides it.
export const OptimizablePromptSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Module name is required")
    .max(SHORT_TEXT_MAX, "Module name must be at most 200 characters")
    .regex(/^[A-Za-z0-9_-]+$/, "Use letters, digits, hyphens, or underscores"),
  seed: z
    .string()
    .trim()
    .min(1, "Seed prompt is required")
    .max(LONG_TEXT_MAX, "Seed prompt must be at most 65536 characters"),
});

// The declared↔referenced cross-check between a Module list and a request template:
// every declared Module must be referenced as {{prompt:<name>}} and vice-versa. Shared by
// the inline optimization-connection schema and the connection Modules-edit schema, so the
// rule can't drift between the create and edit surfaces.
function addPromptRefIssues(
  modules: { name: string }[],
  requestTemplate: string,
  ctx: z.RefinementCtx
) {
  const declared = new Set(modules.map((m) => m.name));
  const referenced = new Set(extractPromptRefs(requestTemplate));
  for (const name of declared) {
    if (!referenced.has(name)) {
      ctx.addIssue({
        code: "custom",
        path: ["requestTemplate"],
        message: `Declared Module "${name}" must be referenced as {{prompt:${name}}} in the request template.`,
      });
    }
  }
  for (const name of referenced) {
    if (!declared.has(name)) {
      ctx.addIssue({
        code: "custom",
        path: ["requestTemplate"],
        message: `Request template references {{prompt:${name}}} but no Module "${name}" is declared.`,
      });
    }
  }
}

// agent: an endpoint Baseline invokes per input row to produce agent_output live.
const AgentConnectionSchema = z.object({
  type: z.literal("agent"),
  name: connectionName,
  endpoint: endpointField,
  authHeader: authHeaderField,
  authValue: authValueField,
  requestTemplate: z
    .string()
    .trim()
    .min(1, "Request template is required")
    .max(LONG_TEXT_MAX, "Request template must be at most 65536 characters"),
  responsePath: z
    .string()
    .trim()
    .min(1, "Response path is required")
    .max(MEDIUM_TEXT_MAX, "Response path must be at most 2000 characters"),
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
  authHeader: authHeaderField,
  authValue: authValueField,
  requestTemplate: z
    .string()
    .trim()
    .min(1, "Query template is required")
    .max(LONG_TEXT_MAX, "Query template must be at most 65536 characters"),
  responsePath: z
    .string()
    .trim()
    .min(1, "Rows path is required")
    .max(MEDIUM_TEXT_MAX, "Rows path must be at most 2000 characters"),
  fieldMap: FieldMapSchema,
});

// posthog dataset: run a HogQL query whose columns are aliased to our field names.
const PosthogDatasetConnectionSchema = z.object({
  type: z.literal("posthog_dataset"),
  name: connectionName,
  host: posthogHostField,
  projectId: z
    .string()
    .trim()
    .min(1, "PostHog project id is required")
    .max(SHORT_TEXT_MAX, "PostHog project id must be at most 200 characters"),
  apiKey: z
    .string()
    .trim()
    .min(1, "PostHog API key is required")
    .max(MEDIUM_TEXT_MAX, "PostHog API key must be at most 2000 characters"),
  hogql: z
    .string()
    .trim()
    .min(1, "HogQL query is required")
    .max(LONG_TEXT_MAX, "HogQL query must be at most 65536 characters"),
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
    // The declared↔referenced cross-check must hold on EVERY path that creates an agent
    // Connection — createConnection and createSchedule both parse with this schema, so a
    // direct (non-wizard) caller can't persist a Module set the worker would reject at
    // run time. Mirrors NewOptimizationConnectionSchema / UpdateConnectionModulesSchema.
    if (c.type === "agent") {
      addPromptRefIssues(c.optimizablePrompts, c.requestTemplate, ctx);
    }
  });

export function isDatasetConnectionType(type: string): boolean {
  return type === "custom_dataset" || type === "posthog_dataset";
}

// ---------- Schedule ----------

export const ScheduleInputRowSchema = z.object({
  userInput: z
    .string()
    .trim()
    .min(1, "User input is required")
    .max(LONG_TEXT_MAX, "User input must be at most 65536 characters"),
  expectedOutput: z
    .string()
    .max(LONG_TEXT_MAX, "Expected output must be at most 65536 characters")
    .optional()
    .nullable(),
  retrievalContext: z
    .string()
    .max(LONG_TEXT_MAX, "Retrieval context must be at most 65536 characters")
    .optional()
    .nullable(),
});

export const ScheduleCadenceSchema = z
  .object({
    frequency: z.enum(["hourly", "daily", "weekly", "monthly"]),
    localHour: z.number().int().min(0).max(23).nullable().optional(),
    daysOfWeek: z.array(z.number().int().min(1).max(7)).optional(),
    dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
    timezone: z.string().min(1, "Timezone is required").max(SHORT_TEXT_MAX, "Invalid timezone"),
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
    name: z
      .string()
      .trim()
      .min(1, "Schedule name is required")
      .max(SHORT_TEXT_MAX, "Schedule name must be at most 200 characters"),
    description: z
      .string()
      .max(MEDIUM_TEXT_MAX, "Description must be at most 2000 characters")
      .optional()
      .nullable(),
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
  userInput: z
    .string()
    .trim()
    .min(1, "User input is required")
    .max(LONG_TEXT_MAX, "User input must be at most 65536 characters"),
  expectedOutput: z
    .string()
    .max(LONG_TEXT_MAX, "Expected output must be at most 65536 characters")
    .optional()
    .nullable(),
  retrievalContext: z
    .string()
    .max(LONG_TEXT_MAX, "Retrieval context must be at most 65536 characters")
    .optional()
    .nullable(),
});

// An agent Connection created inline from the optimization wizard's System step (#108).
// Agent-only — datasets can't be optimized — with ≥1 declared Module, and the request
// template's {{prompt:*}} references must exactly match the declared Module names. Catching
// the declared↔referenced mismatch here means a launch can't fail later on a stale template.
export const NewOptimizationConnectionSchema = AgentConnectionSchema.extend({
  optimizablePrompts: z
    .array(OptimizablePromptSchema)
    .min(1, "Declare at least one Module")
    .refine(
      (modules) => new Set(modules.map((m) => m.name)).size === modules.length,
      "Module names must be unique"
    ),
}).superRefine((c, ctx) => {
  if (c.authValue && !c.authHeader) {
    ctx.addIssue({
      code: "custom",
      path: ["authHeader"],
      message: "Add an auth header name for the auth value (e.g. Authorization)",
    });
  }
  addPromptRefIssues(c.optimizablePrompts, c.requestTemplate, ctx);
});

// Edit the Modules (and the request template that references them) on an EXISTING agent
// Connection (#119). An empty Module list is allowed — it returns the Connection to the
// plain {{user_input}}-only shape — but the declared↔referenced cross-check always holds,
// so a template that references {{prompt:*}} can't be left without its Modules.
export const UpdateConnectionModulesSchema = z
  .object({
    connectionId: z.string().uuid("Invalid connection"),
    requestTemplate: z
      .string()
      .trim()
      .min(1, "Request template is required")
      .max(LONG_TEXT_MAX, "Request template must be at most 65536 characters")
      .refine((t) => {
        try {
          JSON.parse(t);
          return true;
        } catch {
          return false;
        }
      }, "Request template must be valid JSON"),
    modules: z
      .array(OptimizablePromptSchema)
      .refine(
        (modules) => new Set(modules.map((m) => m.name)).size === modules.length,
        "Module names must be unique"
      ),
  })
  .superRefine((c, ctx) => addPromptRefIssues(c.modules, c.requestTemplate, ctx));

// Start a manual, one-shot Optimization Run (D11) over an agent Connection's declared
// Modules. The instance set is capped (D9, v1 sizing) and frozen at run start. The System is
// either an existing agent Connection (connectionId) or one created inline (newConnection) —
// exactly one of the two.
export const CreateOptimizationRunSchema = z
  .object({
    connectionId: z.string().uuid("Select an agent connection").optional().nullable(),
    newConnection: NewOptimizationConnectionSchema.optional().nullable(),
    rubricId: z.string().uuid("Select a rubric"),
    evalType: z.literal("tabular").default("tabular"),
    instances: z
      .array(OptimizationInstanceSchema)
      .min(1, "At least one input instance is required")
      .max(50, "Up to 50 instances in v1"),
    budgetRollouts: z.number().int().positive("Set a rollout budget").max(2000),
    maxIters: z.number().int().positive().max(200).default(20),
    plateauPatience: z.number().int().positive().nullable().optional(),
    reflectModel: z
      .string()
      .trim()
      .min(1)
      .max(MEDIUM_TEXT_MAX, "Reflect model must be at most 2000 characters")
      .optional(),
  })
  .superRefine((o, ctx) => {
    if (!o.connectionId === !o.newConnection) {
      ctx.addIssue({
        code: "custom",
        path: ["connectionId"],
        message: "Provide either an existing agent connection or a new one.",
      });
    }
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

// ---------- Credentials ----------

// The full sign-UP password policy: at least MIN_PASSWORD_LENGTH characters,
// single-sourced from the same constant Supabase's `minimum_password_length`
// (supabase/config.toml) and the account/reset forms enforce. Used to reject a
// too-short password before we ever call signUp.
export const PasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);

// Sign-up credentials enforce the full policy (valid email + min-length password).
export const SignUpSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
});

// Sign-IN deliberately does NOT enforce the min-length policy: an existing account
// created before (or outside) the current policy could have a shorter password, and
// a length gate here would lock it out. We only require a well-formed email and a
// non-empty password — the provider remains the authority on the actual credential.
export const SignInSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1, "Password is required."),
});

// ---------- Invitation ----------

// An org admin invites a person by email.
export const InviteSchema = z.object({
  email: EmailSchema,
});
