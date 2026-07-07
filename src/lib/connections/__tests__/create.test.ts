import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// --- Mocks ---

// create.ts has `import "server-only"`, which throws outside a server bundle.
vi.mock("server-only", () => ({}));

interface MockBuilder {
  from: Mock;
  insert: Mock;
  select: Mock;
  single: Mock;
  rpc: Mock;
}

const builder: MockBuilder = {
  from: vi.fn(),
  insert: vi.fn(),
  select: vi.fn(),
  single: vi.fn(),
  rpc: vi.fn(),
};

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: builder }));

// --- Fixtures ---

function validData(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    name: "Support agent",
    endpoint: "https://api.example.com/agent",
    authHeader: "Authorization",
    authValue: "Bearer sk-123",
    requestTemplate: '{"input":"{{user_input}}"}',
    responsePath: "output",
    optimizablePrompts: [],
    ...overrides,
  } as Parameters<
    typeof import("../create")["insertConnection"]
  >[2];
}

function validPosthogData(overrides: Record<string, unknown> = {}) {
  return {
    type: "posthog_dataset",
    name: "Prod traces",
    host: "https://us.posthog.com",
    projectId: "440128",
    apiKey: "phx_secret",
    hogql: "SELECT a AS user_input, b AS agent_output FROM events LIMIT {{max_rows}}",
    ...overrides,
  } as Parameters<
    typeof import("../create")["insertConnection"]
  >[2];
}

// Route rpc by function name; tests override return values as needed.
function routeRpc(opts: { secretId?: string | null; secretErr?: unknown; deleteErr?: unknown } = {}) {
  builder.rpc.mockImplementation((fn: string) => {
    if (fn === "create_connection_secret") {
      return Promise.resolve({
        data: opts.secretId === undefined ? "secret_1" : opts.secretId,
        error: opts.secretErr ?? null,
      });
    }
    if (fn === "delete_connection_secret") {
      return Promise.resolve({ data: null, error: opts.deleteErr ?? null });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  builder.from.mockReturnValue(builder);
  builder.insert.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.single.mockResolvedValue({ data: { id: "conn_1" }, error: null });
  routeRpc();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// --- insertConnection ---

describe("insertConnection", () => {
  it("returns error for an invalid request template (no secret created)", async () => {
    const { insertConnection } = await import("../create");
    const result = await insertConnection("org_1", "user_1", validData({ requestTemplate: "{ not json" }));
    expect(result).toEqual({ error: "Request template must be valid JSON" });
    expect(builder.rpc).not.toHaveBeenCalled();
  });

  it("stores the credential in Vault and inserts the row with the secret ref", async () => {
    const { insertConnection } = await import("../create");
    const result = await insertConnection("org_1", "user_1", validData());
    expect(result).toEqual({ connectionId: "conn_1" });
    expect(builder.rpc).toHaveBeenCalledWith(
      "create_connection_secret",
      expect.objectContaining({ p_secret: "Bearer sk-123" })
    );
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ auth_secret_id: "secret_1", auth_header: "Authorization" })
    );
  });

  it("persists declared optimizable prompt Modules as a jsonb array", async () => {
    const { insertConnection } = await import("../create");
    const optimizablePrompts = [{ name: "system", seed: "You are helpful." }];
    const result = await insertConnection(
      "org_1",
      "user_1",
      validData({
        optimizablePrompts,
        requestTemplate: '{"system":"{{prompt:system}}","input":"{{user_input}}"}',
      })
    );
    expect(result).toEqual({ connectionId: "conn_1" });
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ optimizable_prompts: optimizablePrompts })
    );
  });

  it("stores null optimizable_prompts for a plain agent with no Modules", async () => {
    const { insertConnection } = await import("../create");
    await insertConnection("org_1", "user_1", validData({ optimizablePrompts: [] }));
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ optimizable_prompts: null })
    );
  });

  it("skips Vault and stores no auth_header when there is no credential", async () => {
    const { insertConnection } = await import("../create");
    const result = await insertConnection("org_1", "user_1", validData({ authValue: null }));
    expect(result).toEqual({ connectionId: "conn_1" });
    expect(builder.rpc).not.toHaveBeenCalled();
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ auth_secret_id: null, auth_header: null })
    );
  });

  it("returns an error when secret creation fails", async () => {
    routeRpc({ secretId: null, secretErr: { message: "vault down" } });
    const { insertConnection } = await import("../create");
    const result = await insertConnection("org_1", "user_1", validData());
    expect(result).toEqual({ error: "Failed to store credential" });
    expect(builder.insert).not.toHaveBeenCalled();
  });

  it("deletes the orphaned Vault secret when the row insert fails", async () => {
    builder.single.mockResolvedValue({ data: null, error: { message: "constraint" } });
    const { insertConnection } = await import("../create");
    const result = await insertConnection("org_1", "user_1", validData());
    expect(result).toEqual({ error: "Failed to save connection" });
    // The just-created secret must be cleaned up (no row exists for the trigger).
    expect(builder.rpc).toHaveBeenCalledWith("delete_connection_secret", { p_secret_id: "secret_1" });
  });

  it("does not attempt secret cleanup on row-insert failure when there was no credential", async () => {
    builder.single.mockResolvedValue({ data: null, error: { message: "constraint" } });
    const { insertConnection } = await import("../create");
    const result = await insertConnection("org_1", "user_1", validData({ authValue: null }));
    expect(result).toEqual({ error: "Failed to save connection" });
    expect(builder.rpc).not.toHaveBeenCalledWith("delete_connection_secret", expect.anything());
  });

  // --- request_template ↔ declared Modules cross-validation (#94) ---

  it("saves when every {{prompt:*}} reference is a declared Module", async () => {
    const { insertConnection } = await import("../create");
    const result = await insertConnection(
      "org_1",
      "user_1",
      validData({
        requestTemplate: '{"system":"{{prompt:system}}","input":"{{user_input}}"}',
        optimizablePrompts: [{ name: "system", seed: "You are helpful." }],
      })
    );
    expect(result).toEqual({ connectionId: "conn_1" });
  });

  it("rejects a typo'd reference with the runtime guard's message naming the Module", async () => {
    const { insertConnection } = await import("../create");
    // Declares `system` but the template references {{prompt:systme}}.
    const result = await insertConnection(
      "org_1",
      "user_1",
      validData({
        requestTemplate: '{"system":"{{prompt:systme}}","input":"{{user_input}}"}',
        optimizablePrompts: [{ name: "system", seed: "You are helpful." }],
      })
    );
    expect(result).toEqual({
      error:
        "Request template references {{prompt:}} Module(s) not declared on the Connection: systme",
    });
    // Rejected before any side effects: no Vault secret, no row.
    expect(builder.rpc).not.toHaveBeenCalled();
    expect(builder.insert).not.toHaveBeenCalled();
  });

  it("rejects an undeclared reference when no Modules are declared, naming each offender", async () => {
    const { insertConnection } = await import("../create");
    const result = await insertConnection(
      "org_1",
      "user_1",
      validData({
        requestTemplate: '{"a":"{{prompt:system}}","b":"{{prompt:style}}"}',
        optimizablePrompts: [],
      })
    );
    expect(result).toEqual({
      error:
        "Request template references {{prompt:}} Module(s) not declared on the Connection: system, style",
    });
    expect(builder.insert).not.toHaveBeenCalled();
  });

  it("saves a template with no {{prompt:}} references at all", async () => {
    const { insertConnection } = await import("../create");
    const result = await insertConnection(
      "org_1",
      "user_1",
      validData({ requestTemplate: '{"input":"{{user_input}}"}', optimizablePrompts: [] })
    );
    expect(result).toEqual({ connectionId: "conn_1" });
  });

  it("soft-warns (does not reject) on a declared Module the template never references", async () => {
    const { insertConnection } = await import("../create");
    const result = await insertConnection(
      "org_1",
      "user_1",
      validData({
        requestTemplate: '{"input":"{{user_input}}"}',
        optimizablePrompts: [{ name: "system", seed: "You are helpful." }],
      })
    );
    expect(result).toEqual({
      connectionId: "conn_1",
      warning:
        "Declared Module(s) never referenced by the request template: system. The agent will not receive these prompts.",
    });
    expect(builder.insert).toHaveBeenCalled();
  });

  it("ignores {{prompt:}} tokens in object keys, matching the renderer's traversal", async () => {
    const { insertConnection } = await import("../create");
    // The renderer never substitutes keys, so an undeclared ref there must not block the save.
    const result = await insertConnection(
      "org_1",
      "user_1",
      validData({
        requestTemplate: '{"{{prompt:ghost}}":"literal","input":"{{user_input}}"}',
        optimizablePrompts: [],
      })
    );
    expect(result).toEqual({ connectionId: "conn_1" });
  });

  it("stores a managed agent: managed shape, single Module seed, auto-derived name, no secret", async () => {
    const { insertConnection } = await import("../create");
    const result = await insertConnection("org_1", "user_1", {
      type: "managed_agent",
      targetModel: "claude-haiku-4-5-20251001",
      prompt: "You are a helpful support agent.\nAlways be concise.",
    } as Parameters<typeof import("../create")["insertConnection"]>[2]);
    expect(result).toEqual({ connectionId: "conn_1" });
    // A Managed Agent carries no credential — Vault is never touched.
    expect(builder.rpc).not.toHaveBeenCalled();
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "agent",
        agent_kind: "managed",
        provider: "anthropic",
        target_model: "claude-haiku-4-5-20251001",
        // The connections_agent_kind_shape CHECK requires these null for a managed agent.
        endpoint: null,
        response_path: null,
        request_template: null,
        auth_header: null,
        auth_secret_id: null,
        // One Module, its seed = the prompt; name auto-derived from the prompt's first line.
        optimizable_prompts: [{ name: "prompt", seed: "You are a helpful support agent.\nAlways be concise." }],
        name: "You are a helpful support agent.",
      })
    );
  });

  it("stores a posthog dataset connection: provider, results path, Bearer key, and config", async () => {
    const { insertConnection } = await import("../create");
    const result = await insertConnection("org_1", "user_1", validPosthogData());
    expect(result).toEqual({ connectionId: "conn_1" });
    // The raw key is wrapped to a full header value before going to Vault.
    expect(builder.rpc).toHaveBeenCalledWith(
      "create_connection_secret",
      expect.objectContaining({ p_secret: "Bearer phx_secret" })
    );
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "dataset",
        provider: "posthog",
        endpoint: "https://us.posthog.com",
        auth_header: "Authorization",
        response_path: "results",
        config: expect.objectContaining({ project_id: "440128" }),
      })
    );
  });
});
