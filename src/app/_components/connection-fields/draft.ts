// The connection-create form's data model, validation, and payload builder — shared by the
// schedule wizard, the standalone Add Connection dialog, and the optimization wizard's inline
// agent form. Every surface that creates a Connection collects the same fields, validates them
// the same way, and POSTs the same `NewConnectionSchema` shape; keeping that here is the single
// source those surfaces draw from. The form JSX lives in connection-fields.tsx; the field state
// + the type-swap behaviour lives in use-connection-draft.ts.
import type { z } from "zod";
import {
  CONN_TYPE,
  type ConnType,
  DEFAULT_AGENT_TEMPLATE,
} from "@/lib/connections/wizard-constants";
import {
  cleanModules,
  modulesEditorError,
  type ModuleRow,
} from "@/app/_components/modules-editor";
import { endpointUrlError } from "@/lib/connections/endpoint";
import {
  isAllowedPosthogHostUrl,
  POSTHOG_HOST_MESSAGE,
} from "@/lib/connections/posthog-host";
import { extractPromptRefs } from "@/lib/optimization/prompt-refs";
import {
  DEFAULT_TARGET_MODEL,
  type TargetModelId,
} from "@/lib/optimization/models";
import type { NewConnectionSchema } from "@/lib/validation/schemas";

// next-intl translator shape — narrow enough that callers can pass any namespace's `t`.
type Translator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

// Every field the four connection types can collect. A single flat bag (not a per-type union) so
// the form can switch types without losing what the user already typed; buildConnectionPayload
// projects out only the fields the chosen type needs.
export interface ConnectionDraft {
  connType: ConnType;
  // Managed "Paste a prompt" System (#294): just the prompt and the model it runs on. The
  // managed Connection is auto-named server-side, so it has no name field.
  managedPrompt: string;
  managedTargetModel: string;
  // Shared agent / dataset fields.
  connName: string;
  endpoint: string;
  authHeader: string;
  authValue: string;
  requestTemplate: string;
  responsePath: string;
  // Agent-only optional optimizable Modules.
  modules: ModuleRow[];
  // Custom dataset field map.
  mapUserInput: string;
  mapAgentOutput: string;
  // PostHog dataset.
  phHost: string;
  phProjectId: string;
  phApiKey: string;
  phHogql: string;
}

// The defaults a fresh form opens with. Surfaces may override `requestTemplate`, `modules`, and
// `connType` at construction (the optimization wizard seeds a `{{prompt:system}}` template and a
// mandatory `system` Module).
export const CONNECTION_DRAFT_DEFAULTS: ConnectionDraft = {
  connType: CONN_TYPE.agent,
  managedPrompt: "",
  managedTargetModel: DEFAULT_TARGET_MODEL,
  connName: "",
  endpoint: "",
  authHeader: "Authorization",
  authValue: "",
  requestTemplate: DEFAULT_AGENT_TEMPLATE,
  responsePath: "output",
  modules: [],
  mapUserInput: "input",
  mapAgentOutput: "output",
  phHost: "https://us.posthog.com",
  phProjectId: "",
  phApiKey: "",
  phHogql: "",
};

// Client-side validation for the draft, keyed by type. Returns a user-facing error string or
// null. The server re-validates with NewConnectionSchema regardless; this is the inline nudge.
// `endpointUrlError` / POSTHOG_HOST_MESSAGE return their own (non-localized) messages; the rest
// come from the caller's `t` so each surface keeps its catalog.
export function connectionDraftError(
  draft: ConnectionDraft,
  {
    managedAllowed,
    requireModules = false,
    t,
    tModules,
  }: {
    managedAllowed: boolean;
    // The optimization run needs something to tune, so its inline agent requires ≥1 Module;
    // the schedule/connections agent leaves them optional.
    requireModules?: boolean;
    t: Translator;
    tModules: Translator;
  },
): string | null {
  if (draft.connType === CONN_TYPE.managedAgent) {
    // Belt to the disabled pill — the server gate (#292) is the authority.
    if (!managedAllowed) return t("errManagedPaid");
    if (!draft.managedPrompt.trim()) return t("errPrompt");
    return null;
  }
  if (draft.connType === CONN_TYPE.posthogDataset) {
    if (!draft.connName.trim()) return t("errNameConnection");
    const phHostError = endpointUrlError(draft.phHost);
    if (phHostError) return phHostError;
    if (!isAllowedPosthogHostUrl(draft.phHost)) return POSTHOG_HOST_MESSAGE;
    if (!draft.phProjectId.trim()) return t("errProjectId");
    if (!draft.phApiKey.trim()) return t("errApiKey");
    if (!draft.phHogql.trim()) return t("errHogql");
    return null;
  }
  // agent or custom_dataset
  if (!draft.connName.trim()) return t("errNameConnection");
  const endpointError = endpointUrlError(draft.endpoint);
  if (endpointError) return endpointError;
  try {
    JSON.parse(draft.requestTemplate);
  } catch {
    return draft.connType === CONN_TYPE.agent
      ? t("errRequestTemplateJson")
      : t("errQueryTemplateJson");
  }
  if (!draft.responsePath.trim())
    return draft.connType === CONN_TYPE.agent
      ? t("errResponsePath")
      : t("errRowsPath");
  if (
    draft.connType === CONN_TYPE.customDataset &&
    (!draft.mapUserInput.trim() || !draft.mapAgentOutput.trim())
  )
    return t("errMapPaths");
  // Belt-and-braces: a {{prompt:*}} ref in a dataset query template would be sent literally to
  // the customer's API — Modules only exist on agent connections.
  if (
    draft.connType === CONN_TYPE.customDataset &&
    extractPromptRefs(draft.requestTemplate).length > 0
  )
    return t("errPromptRefDataset");
  if (draft.authValue.trim() && !draft.authHeader.trim())
    return t("errAuthHeader");
  if (draft.connType === CONN_TYPE.agent) {
    // When declared, the shared declared↔referenced cross-validation applies (#119).
    const mErr = modulesEditorError(
      draft.modules,
      draft.requestTemplate,
      { requireModules },
      tModules,
    );
    if (mErr) return mErr;
  }
  return null;
}

// Project the draft into the `NewConnectionSchema` input the createConnection / createSchedule /
// startOptimizationRun actions all accept. Pure data — no copy, no i18n.
export function buildConnectionPayload(
  draft: ConnectionDraft,
): z.input<typeof NewConnectionSchema> {
  if (draft.connType === CONN_TYPE.managedAgent) {
    // The dropdown's options are exactly the TARGET_MODELS ids, so the value is always valid;
    // the server re-validates against the same registry regardless.
    return {
      type: CONN_TYPE.managedAgent,
      targetModel: draft.managedTargetModel as TargetModelId,
      prompt: draft.managedPrompt.trim(),
    };
  }
  if (draft.connType === CONN_TYPE.posthogDataset) {
    return {
      type: CONN_TYPE.posthogDataset,
      name: draft.connName.trim(),
      host: draft.phHost.trim(),
      projectId: draft.phProjectId.trim(),
      apiKey: draft.phApiKey.trim(),
      hogql: draft.phHogql,
    };
  }
  if (draft.connType === CONN_TYPE.customDataset) {
    return {
      type: CONN_TYPE.customDataset,
      name: draft.connName.trim(),
      endpoint: draft.endpoint.trim(),
      authHeader: draft.authHeader.trim() || null,
      // Trim to match the schema's auth-header rule (a whitespace-only value would otherwise
      // pass the client check but trip the server's "value needs a header" refine).
      authValue: draft.authValue.trim() || null,
      requestTemplate: draft.requestTemplate,
      responsePath: draft.responsePath.trim(),
      fieldMap: {
        userInput: draft.mapUserInput.trim(),
        agentOutput: draft.mapAgentOutput.trim(),
      },
    };
  }
  return {
    type: CONN_TYPE.agent,
    name: draft.connName.trim(),
    endpoint: draft.endpoint.trim(),
    authHeader: draft.authHeader.trim() || null,
    authValue: draft.authValue.trim() || null,
    requestTemplate: draft.requestTemplate,
    responsePath: draft.responsePath.trim(),
    // Declared Modules persist on the Connection, making it optimizable later (#119).
    optimizablePrompts: cleanModules(draft.modules),
  };
}
