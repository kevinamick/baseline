import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

interface MockBuilder {
  _result: unknown;
  from: Mock;
  select: Mock;
  eq: Mock;
  order: Mock;
  then: (resolve: (v: unknown) => void) => void;
}

// --- Mocks ---

const mockAuth = vi.fn();
const mockInsertConnection = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));
vi.mock("@/lib/connections/create", () => ({ insertConnection: mockInsertConnection }));

const builder: MockBuilder = {
  _result: { data: null, error: null },
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  order: vi.fn(),
  then: (resolve: (v: unknown) => void) => resolve(builder._result),
};

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: builder }));

// --- Fixtures ---

function validConnection(overrides: Record<string, unknown> = {}) {
  return {
    name: "Support agent",
    endpoint: "https://api.example.com/agent",
    authHeader: null,
    authValue: null,
    requestTemplate: '{"input":"{{user_input}}"}',
    responsePath: "output",
    ...overrides,
  };
}

// --- Setup ---

beforeEach(() => {
  vi.clearAllMocks();
  // Re-establish the chainable builder each test (vitest.config has mockReset:true).
  for (const method of ["from", "select", "eq", "order"] as const) {
    builder[method].mockReturnValue(builder);
  }
  mockAuth.mockResolvedValue({ userId: "user_abc", orgId: "org_abc", orgRole: "org:admin" });
  builder._result = { data: null, error: null };
  mockInsertConnection.mockResolvedValue({ connectionId: "conn_1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// --- createConnection ---

describe("createConnection", () => {
  it("returns error when unauthenticated", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const { createConnection } = await import("../connections");
    expect(await createConnection(validConnection())).toEqual({ error: "Not authenticated" });
  });

  it("rejects non-contributors", async () => {
    mockAuth.mockResolvedValue({ userId: "u", orgId: "o", orgRole: "org:member" });
    const { createConnection } = await import("../connections");
    expect(await createConnection(validConnection())).toEqual({
      error: "Only contributors can create connections",
    });
  });

  it("returns a validation error for a non-https external endpoint", async () => {
    const { createConnection } = await import("../connections");
    const result = await createConnection(validConnection({ endpoint: "http://api.example.com/agent" }));
    expect(result).toHaveProperty("error");
  });

  it("returns a validation error when an auth value has no header", async () => {
    const { createConnection } = await import("../connections");
    const result = await createConnection(validConnection({ authHeader: null, authValue: "Bearer x" }));
    expect(result).toEqual({
      error: "Add an auth header name for the auth value (e.g. Authorization)",
    });
  });

  it("delegates to insertConnection on valid input", async () => {
    const { createConnection } = await import("../connections");
    const result = await createConnection(validConnection());
    expect(result).toEqual({ connectionId: "conn_1" });
    expect(mockInsertConnection).toHaveBeenCalledWith(
      "org_abc",
      "user_abc",
      expect.objectContaining({ name: "Support agent", responsePath: "output" })
    );
  });

  it("propagates an insertConnection error", async () => {
    mockInsertConnection.mockResolvedValue({ error: "Failed to store credential" });
    const { createConnection } = await import("../connections");
    expect(await createConnection(validConnection())).toEqual({ error: "Failed to store credential" });
  });
});

// --- listConnections ---

describe("listConnections", () => {
  it("returns empty array when unauthenticated", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const { listConnections } = await import("../connections");
    expect(await listConnections()).toEqual([]);
  });

  it("scopes the query to the team and returns rows", async () => {
    builder._result = { data: [{ id: "conn_1", name: "Support agent" }], error: null };
    const { listConnections } = await import("../connections");
    const rows = await listConnections();
    expect(rows).toEqual([{ id: "conn_1", name: "Support agent" }]);
    expect(builder.eq).toHaveBeenCalledWith("org_id", "org_abc");
  });
});
