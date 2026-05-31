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
    name: "Support agent",
    endpoint: "https://api.example.com/agent",
    authHeader: "Authorization",
    authValue: "Bearer sk-123",
    requestTemplate: '{"input":"{{user_input}}"}',
    responsePath: "output",
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
});
