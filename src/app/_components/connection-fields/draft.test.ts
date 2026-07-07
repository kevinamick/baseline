import { describe, it, expect } from "vitest";
import {
  CONNECTION_DRAFT_DEFAULTS,
  connectionDraftError,
  buildConnectionPayload,
  type ConnectionDraft,
} from "./draft";
import { CONN_TYPE } from "@/lib/connections/wizard-constants";
import { POSTHOG_HOST_MESSAGE } from "@/lib/connections/posthog-host";
import { ENDPOINT_HTTPS_MESSAGE } from "@/lib/connections/endpoint";
import { NewConnectionSchema } from "@/lib/validation/schemas";

// Identity translators — connectionDraftError's own messages are asserted by key, since the
// real copy lives in the i18n catalogs (see connections-i18n.test.ts / *.dom.test.tsx for
// catalog-key coverage). tModules only matters for the Modules cross-check branch below.
const t = (key: string) => key;
// Second param matches the translator signature modules-editor calls with.
const tModules: (key: string, values?: Record<string, unknown>) => string = (
  key,
) => key;

function draft(overrides: Partial<ConnectionDraft> = {}): ConnectionDraft {
  return { ...CONNECTION_DRAFT_DEFAULTS, ...overrides };
}

function validAgentDraft(overrides: Partial<ConnectionDraft> = {}): ConnectionDraft {
  return draft({
    connType: CONN_TYPE.agent,
    connName: "Support agent",
    endpoint: "https://api.example.com/agent",
    requestTemplate: '{"input": "{{user_input}}"}',
    responsePath: "output",
    ...overrides,
  });
}

function validCustomDatasetDraft(
  overrides: Partial<ConnectionDraft> = {},
): ConnectionDraft {
  return draft({
    connType: CONN_TYPE.customDataset,
    connName: "Logs",
    endpoint: "https://api.example.com/logs",
    requestTemplate: '{"from": "{{window_start}}"}',
    responsePath: "data",
    mapUserInput: "prompt",
    mapAgentOutput: "completion",
    ...overrides,
  });
}

function validPosthogDraft(overrides: Partial<ConnectionDraft> = {}): ConnectionDraft {
  return draft({
    connType: CONN_TYPE.posthogDataset,
    connName: "PostHog source",
    phHost: "https://us.posthog.com",
    phProjectId: "12345",
    phApiKey: "phx_secret",
    phHogql: "SELECT 1",
    ...overrides,
  });
}

function validManagedDraft(overrides: Partial<ConnectionDraft> = {}): ConnectionDraft {
  return draft({
    connType: CONN_TYPE.managedAgent,
    managedPrompt: "You classify refund requests.",
    ...overrides,
  });
}

describe("CONNECTION_DRAFT_DEFAULTS", () => {
  it("defaults to a live agent with the standard template and field-map", () => {
    expect(CONNECTION_DRAFT_DEFAULTS.connType).toBe(CONN_TYPE.agent);
    expect(CONNECTION_DRAFT_DEFAULTS.authHeader).toBe("Authorization");
    expect(CONNECTION_DRAFT_DEFAULTS.responsePath).toBe("output");
    expect(CONNECTION_DRAFT_DEFAULTS.modules).toEqual([]);
    expect(CONNECTION_DRAFT_DEFAULTS.mapUserInput).toBe("input");
    expect(CONNECTION_DRAFT_DEFAULTS.mapAgentOutput).toBe("output");
    expect(CONNECTION_DRAFT_DEFAULTS.phHost).toBe("https://us.posthog.com");
  });
});

describe("connectionDraftError — managed agent", () => {
  it("blocks a managed draft when the plan doesn't allow it, even with a prompt", () => {
    expect(
      connectionDraftError(validManagedDraft(), {
        managedAllowed: false,
        t,
        tModules,
      }),
    ).toBe("errManagedPaid");
  });

  it("requires a non-blank prompt when managed is allowed", () => {
    expect(
      connectionDraftError(validManagedDraft({ managedPrompt: "   " }), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBe("errPrompt");
  });

  it("passes with plan allowed and a prompt", () => {
    expect(
      connectionDraftError(validManagedDraft(), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBeNull();
  });
});

describe("connectionDraftError — PostHog dataset", () => {
  it("requires a connection name", () => {
    expect(
      connectionDraftError(validPosthogDraft({ connName: "  " }), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBe("errNameConnection");
  });

  it("surfaces the shared endpoint error for a malformed host URL", () => {
    expect(
      connectionDraftError(validPosthogDraft({ phHost: "not-a-url" }), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBe("Enter a valid URL (https://…)");
  });

  it("rejects a non-https host in production", () => {
    const prev = process.env.NODE_ENV;
    // @ts-expect-error -- test override of a readonly-in-types env var
    process.env.NODE_ENV = "production";
    try {
      expect(
        connectionDraftError(
          validPosthogDraft({ phHost: "http://us.posthog.com" }),
          { managedAllowed: true, t, tModules },
        ),
      ).toBe(ENDPOINT_HTTPS_MESSAGE);
    } finally {
      // @ts-expect-error -- restore
      process.env.NODE_ENV = prev;
    }
  });

  it("rejects a host that isn't an allowed PostHog address", () => {
    expect(
      connectionDraftError(
        validPosthogDraft({ phHost: "https://evil.example.com" }),
        { managedAllowed: true, t, tModules },
      ),
    ).toBe(POSTHOG_HOST_MESSAGE);
  });

  it("requires a project id", () => {
    expect(
      connectionDraftError(validPosthogDraft({ phProjectId: "" }), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBe("errProjectId");
  });

  it("requires an API key", () => {
    expect(
      connectionDraftError(validPosthogDraft({ phApiKey: "  " }), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBe("errApiKey");
  });

  it("requires a HogQL query", () => {
    expect(
      connectionDraftError(validPosthogDraft({ phHogql: "" }), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBe("errHogql");
  });

  it("passes a fully-filled draft", () => {
    expect(
      connectionDraftError(validPosthogDraft(), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBeNull();
  });
});

describe("connectionDraftError — agent / custom dataset shared rules", () => {
  it("requires a connection name for a live agent", () => {
    expect(
      connectionDraftError(validAgentDraft({ connName: "" }), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBe("errNameConnection");
  });

  it("requires a connection name for a custom dataset", () => {
    expect(
      connectionDraftError(validCustomDatasetDraft({ connName: "" }), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBe("errNameConnection");
  });

  it("surfaces the shared endpoint error for a malformed endpoint", () => {
    expect(
      connectionDraftError(validAgentDraft({ endpoint: "ftp://nope" }), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBe(ENDPOINT_HTTPS_MESSAGE);
  });

  it("rejects invalid JSON request template with the agent-specific message", () => {
    expect(
      connectionDraftError(validAgentDraft({ requestTemplate: "{not json" }), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBe("errRequestTemplateJson");
  });

  it("rejects invalid JSON request template with the dataset-specific message", () => {
    expect(
      connectionDraftError(
        validCustomDatasetDraft({ requestTemplate: "{not json" }),
        { managedAllowed: true, t, tModules },
      ),
    ).toBe("errQueryTemplateJson");
  });

  it("requires a response path for a live agent", () => {
    expect(
      connectionDraftError(validAgentDraft({ responsePath: " " }), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBe("errResponsePath");
  });

  it("requires a rows path for a custom dataset", () => {
    expect(
      connectionDraftError(validCustomDatasetDraft({ responsePath: " " }), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBe("errRowsPath");
  });

  it("requires both field-map paths for a custom dataset", () => {
    expect(
      connectionDraftError(validCustomDatasetDraft({ mapUserInput: "" }), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBe("errMapPaths");
    expect(
      connectionDraftError(validCustomDatasetDraft({ mapAgentOutput: "  " }), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBe("errMapPaths");
  });

  it("does not require field-map paths for a live agent", () => {
    expect(
      connectionDraftError(
        validAgentDraft({ mapUserInput: "", mapAgentOutput: "" }),
        { managedAllowed: true, t, tModules },
      ),
    ).toBeNull();
  });

  it("rejects a {{prompt:*}} ref in a custom-dataset query template", () => {
    expect(
      connectionDraftError(
        validCustomDatasetDraft({
          requestTemplate: '{"system": "{{prompt:system}}"}',
        }),
        { managedAllowed: true, t, tModules },
      ),
    ).toBe("errPromptRefDataset");
  });

  it("allows a {{prompt:*}} ref in an agent's request template (Modules-eligible)", () => {
    expect(
      connectionDraftError(
        validAgentDraft({
          requestTemplate: '{"system": "{{prompt:system}}"}',
          modules: [{ name: "system", seed: "Be helpful." }],
        }),
        { managedAllowed: true, t, tModules },
      ),
    ).toBeNull();
  });

  it("requires an auth header name whenever an auth value is set (agent)", () => {
    expect(
      connectionDraftError(
        validAgentDraft({ authHeader: "  ", authValue: "secret" }),
        { managedAllowed: true, t, tModules },
      ),
    ).toBe("errAuthHeader");
  });

  it("requires an auth header name whenever an auth value is set (custom dataset)", () => {
    expect(
      connectionDraftError(
        validCustomDatasetDraft({ authHeader: "", authValue: "secret" }),
        { managedAllowed: true, t, tModules },
      ),
    ).toBe("errAuthHeader");
  });

  it("allows an auth value with no header to pass when the value itself is blank", () => {
    expect(
      connectionDraftError(
        validAgentDraft({ authHeader: "", authValue: "   " }),
        { managedAllowed: true, t, tModules },
      ),
    ).toBeNull();
  });

  it("passes a fully-filled live-agent draft", () => {
    expect(
      connectionDraftError(validAgentDraft(), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBeNull();
  });

  it("passes a fully-filled custom-dataset draft", () => {
    expect(
      connectionDraftError(validCustomDatasetDraft(), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBeNull();
  });
});

describe("connectionDraftError — agent Modules cross-validation", () => {
  it("requires at least one declared Module when the surface requires Modules", () => {
    expect(
      connectionDraftError(validAgentDraft({ modules: [] }), {
        managedAllowed: true,
        requireModules: true,
        t,
        tModules,
      }),
    ).toBe(tModules("errAtLeastOne"));
  });

  it("does not require Modules when the surface leaves them optional (default)", () => {
    expect(
      connectionDraftError(validAgentDraft({ modules: [] }), {
        managedAllowed: true,
        t,
        tModules,
      }),
    ).toBeNull();
  });

  it("flags a declared Module missing its {{prompt:name}} reference", () => {
    expect(
      connectionDraftError(
        validAgentDraft({
          modules: [{ name: "system", seed: "Be helpful." }],
        }),
        { managedAllowed: true, t, tModules },
      ),
    ).toBe(tModules("errMissingRef", { name: "system" }));
  });

  it("never runs the Modules cross-check for a custom dataset draft", () => {
    // Even a template that would fail modulesEditorError is irrelevant off the agent path —
    // the earlier errPromptRefDataset check already rejects {{prompt:*}} refs for datasets.
    expect(
      connectionDraftError(
        validCustomDatasetDraft({ modules: [{ name: "", seed: "orphaned" }] }),
        { managedAllowed: true, t, tModules },
      ),
    ).toBeNull();
  });
});

describe("buildConnectionPayload — managed agent", () => {
  it("projects the trimmed prompt and chosen target model", () => {
    const payload = buildConnectionPayload(
      validManagedDraft({
        managedPrompt: "  Classify refunds.  ",
        managedTargetModel: "claude-haiku-4-5-20251001",
      }),
    );
    expect(payload).toEqual({
      type: CONN_TYPE.managedAgent,
      targetModel: "claude-haiku-4-5-20251001",
      prompt: "Classify refunds.",
    });
    expect(NewConnectionSchema.safeParse(payload).success).toBe(true);
  });
});

describe("buildConnectionPayload — PostHog dataset", () => {
  it("projects and trims the PostHog fields, leaving the HogQL body untrimmed", () => {
    const payload = buildConnectionPayload(
      validPosthogDraft({
        connName: "  PostHog source  ",
        phHost: "  https://us.posthog.com  ",
        phProjectId: "  12345  ",
        phApiKey: "  phx_secret  ",
        phHogql: "  SELECT 1  ",
      }),
    );
    expect(payload).toEqual({
      type: CONN_TYPE.posthogDataset,
      name: "PostHog source",
      host: "https://us.posthog.com",
      projectId: "12345",
      apiKey: "phx_secret",
      hogql: "  SELECT 1  ",
    });
    expect(NewConnectionSchema.safeParse(payload).success).toBe(true);
  });
});

describe("buildConnectionPayload — custom dataset", () => {
  it("projects the field-map and nulls out a blank auth pair", () => {
    const payload = buildConnectionPayload(
      validCustomDatasetDraft({ authHeader: "", authValue: "" }),
    );
    expect(payload).toEqual({
      type: CONN_TYPE.customDataset,
      name: "Logs",
      endpoint: "https://api.example.com/logs",
      authHeader: null,
      authValue: null,
      requestTemplate: '{"from": "{{window_start}}"}',
      responsePath: "data",
      fieldMap: { userInput: "prompt", agentOutput: "completion" },
    });
    expect(NewConnectionSchema.safeParse(payload).success).toBe(true);
  });

  it("trims a whitespace-only auth value down to null (matches the server refine)", () => {
    const payload = buildConnectionPayload(
      validCustomDatasetDraft({ authHeader: "Authorization", authValue: "   " }),
    ) as { authHeader: string | null; authValue: string | null };
    expect(payload.authHeader).toBe("Authorization");
    expect(payload.authValue).toBeNull();
  });

  it("keeps a real auth header/value pair trimmed", () => {
    const payload = buildConnectionPayload(
      validCustomDatasetDraft({
        authHeader: "  Authorization  ",
        authValue: "  Bearer abc  ",
      }),
    ) as { authHeader: string | null; authValue: string | null };
    expect(payload.authHeader).toBe("Authorization");
    expect(payload.authValue).toBe("Bearer abc");
  });
});

describe("buildConnectionPayload — live agent (default branch)", () => {
  it("projects endpoint fields and cleaned Modules", () => {
    const payload = buildConnectionPayload(
      validAgentDraft({
        requestTemplate: '{"input": "{{user_input}}", "system": "{{prompt:system}}"}',
        modules: [
          { name: "system", seed: "  Be helpful.  " },
          { name: "  ", seed: "orphaned, dropped" },
        ],
      }),
    );
    expect(payload).toEqual({
      type: CONN_TYPE.agent,
      name: "Support agent",
      endpoint: "https://api.example.com/agent",
      authHeader: "Authorization",
      authValue: null,
      requestTemplate: '{"input": "{{user_input}}", "system": "{{prompt:system}}"}',
      responsePath: "output",
      optimizablePrompts: [{ name: "system", seed: "Be helpful." }],
    });
    expect(NewConnectionSchema.safeParse(payload).success).toBe(true);
  });

  it("nulls out a blank auth header/value pair for the agent branch too", () => {
    const payload = buildConnectionPayload(
      validAgentDraft({ authHeader: "  ", authValue: "  " }),
    ) as { authHeader: string | null; authValue: string | null };
    expect(payload.authHeader).toBeNull();
    expect(payload.authValue).toBeNull();
  });

  it("falls through to the agent branch for any connType other than the three named ones", () => {
    // buildConnectionPayload's final `return` is an unconditional agent-shaped fallback —
    // exercise it directly via the CONN_TYPE.agent value to pin that behaviour.
    const payload = buildConnectionPayload(validAgentDraft({ modules: [] }));
    expect(payload.type).toBe(CONN_TYPE.agent);
    expect((payload as { optimizablePrompts: unknown[] }).optimizablePrompts).toEqual(
      [],
    );
  });
});
