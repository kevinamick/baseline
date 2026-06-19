import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// The logging module has `import "server-only"`, which throws outside a server bundle.
vi.mock("server-only", () => ({}));

interface MockBuilder {
  _result: unknown;
  from: Mock;
  select: Mock;
  update: Mock;
  delete: Mock;
  eq: Mock;
  in: Mock;
  limit: Mock;
  order: Mock;
  rpc: Mock;
  maybeSingle: Mock;
  // Awaited terminal queries (counts, delete) resolve here. _queue lets a test feed an ordered
  // sequence of distinct results; otherwise every await falls back to the shared _result.
  _queue: unknown[];
  then: (resolve: (v: unknown) => void) => void;
}

// --- Mocks ---

const mockGetAuthContext = vi.fn();
const mockInsertConnection = vi.fn();
const mockTrack = vi.fn();

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/connections/create", () => ({ insertConnection: mockInsertConnection }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
vi.mock("@/lib/logging/server", () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const builder: MockBuilder = {
  _result: { data: null, error: null },
  from: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  eq: vi.fn(),
  in: vi.fn(),
  limit: vi.fn(),
  order: vi.fn(),
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
  _queue: [],
  then: (resolve: (v: unknown) => void) =>
    resolve(builder._queue.length ? builder._queue.shift() : builder._result),
};

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: builder }));

// --- Fixtures ---

function validConnection(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent" as const,
    name: "Support agent",
    endpoint: "https://api.example.com/agent",
    authHeader: null,
    authValue: null,
    requestTemplate: '{"input":"{{user_input}}"}',
    responsePath: "output",
    ...overrides,
  };
}

function validPosthogConnection(overrides: Record<string, unknown> = {}) {
  return {
    type: "posthog_dataset" as const,
    name: "Prod traces",
    host: "https://us.posthog.com",
    projectId: "440128",
    apiKey: "phx_secret",
    hogql: "SELECT a AS user_input, b AS agent_output FROM events LIMIT {{max_rows}}",
    ...overrides,
  };
}

// --- Setup ---

beforeEach(() => {
  vi.clearAllMocks();
  // Re-establish the chainable builder each test (vitest.config has mockReset:true).
  for (const method of ["from", "select", "update", "delete", "eq", "in", "limit", "order"] as const) {
    builder[method].mockReturnValue(builder);
  }
  mockGetAuthContext.mockResolvedValue({ userId: "user_abc", orgId: "org_abc", role: "admin", canWrite: true });
  builder.rpc.mockResolvedValue({ error: null });
  builder._result = { data: null, error: null };
  builder._queue = [];
  mockInsertConnection.mockResolvedValue({ connectionId: "conn_1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// --- createConnection ---

describe("createConnection", () => {
  it("returns error when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
    const { createConnection } = await import("../connections");
    expect(await createConnection(validConnection())).toEqual({ error: "Not authenticated" });
  });

  it("rejects non-contributors", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "u", orgId: "o", role: "member", canWrite: false });
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

  it("accepts a valid PostHog dataset connection and delegates", async () => {
    const { createConnection } = await import("../connections");
    const result = await createConnection(validPosthogConnection());
    expect(result).toEqual({ connectionId: "conn_1" });
    expect(mockInsertConnection).toHaveBeenCalledWith(
      "org_abc",
      "user_abc",
      expect.objectContaining({ type: "posthog_dataset", projectId: "440128" })
    );
  });

  it("rejects a PostHog dataset connection missing its API key", async () => {
    const { createConnection } = await import("../connections");
    const result = await createConnection(validPosthogConnection({ apiKey: "" }));
    expect(result).toHaveProperty("error");
    expect(mockInsertConnection).not.toHaveBeenCalled();
  });

  // --- declared↔referenced cross-validation on the CREATE path (#119 review) ---
  // NewConnectionSchema is also what createSchedule parses newConnection with, so these
  // guard every server path that creates an agent Connection — not just the wizards.

  it("rejects an agent whose template references an undeclared Module", async () => {
    const { createConnection } = await import("../connections");
    const result = await createConnection(
      validConnection({
        requestTemplate: '{"input":"{{user_input}}","system":"{{prompt:system}}"}',
        optimizablePrompts: [],
      })
    );
    expect(result).toEqual({
      error: 'Request template references {{prompt:system}} but no Module "system" is declared.',
    });
    expect(mockInsertConnection).not.toHaveBeenCalled();
  });

  it("rejects an agent declaring a Module the template never references", async () => {
    const { createConnection } = await import("../connections");
    const result = await createConnection(
      validConnection({
        optimizablePrompts: [{ name: "system", seed: "Answer helpfully." }],
      })
    );
    expect(result).toEqual({
      error:
        'Declared Module "system" must be referenced as {{prompt:system}} in the request template.',
    });
    expect(mockInsertConnection).not.toHaveBeenCalled();
  });

  it("accepts an agent whose declared Modules and template references match", async () => {
    const { createConnection } = await import("../connections");
    const result = await createConnection(
      validConnection({
        requestTemplate: '{"input":"{{user_input}}","system":"{{prompt:system}}"}',
        optimizablePrompts: [{ name: "system", seed: "Answer helpfully." }],
      })
    );
    expect(result).toEqual({ connectionId: "conn_1" });
  });
});

// --- updateConnectionModules ---

const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

function validUpdate(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: CONNECTION_ID,
    requestTemplate: '{"input":"{{user_input}}","system":"{{prompt:system}}"}',
    modules: [{ name: "system", seed: "Answer helpfully." }],
    ...overrides,
  };
}

describe("updateConnectionModules", () => {
  it("returns error when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
    const { updateConnectionModules } = await import("../connections");
    expect(await updateConnectionModules(validUpdate())).toEqual({ error: "Not authenticated" });
  });

  it("rejects non-contributors", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "u", orgId: "o", role: "member", canWrite: false });
    const { updateConnectionModules } = await import("../connections");
    expect(await updateConnectionModules(validUpdate())).toEqual({
      error: "Only contributors can edit connections",
    });
  });

  it("blocks the edit while an optimization run is active on the connection", async () => {
    builder.maybeSingle
      // connection lookup: an agent owned by the org
      .mockResolvedValueOnce({ data: { id: CONNECTION_ID, kind: "agent" }, error: null })
      // active-run lookup: a queued/running run references this connection
      .mockResolvedValueOnce({ data: { id: "run_1" }, error: null });

    const { updateConnectionModules } = await import("../connections");
    const result = await updateConnectionModules(validUpdate());
    expect(result).toEqual({
      error:
        "An optimization run is currently using this connection — wait for it to finish before editing Modules.",
    });
    // The run-status filter is the non-terminal set, and nothing was written.
    expect(builder.in).toHaveBeenCalledWith("status", ["queued", "running"]);
    expect(builder.update).not.toHaveBeenCalled();
  });

  it("updates Modules and template when no run is active", async () => {
    builder.maybeSingle
      .mockResolvedValueOnce({ data: { id: CONNECTION_ID, kind: "agent" }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    const { updateConnectionModules } = await import("../connections");
    const result = await updateConnectionModules(validUpdate());
    expect(result).toEqual({ ok: true });
    expect(builder.update).toHaveBeenCalledWith({
      request_template: { input: "{{user_input}}", system: "{{prompt:system}}" },
      optimizable_prompts: [{ name: "system", seed: "Answer helpfully." }],
    });
  });

  it("stores null when the Module list is emptied (ref-free template)", async () => {
    builder.maybeSingle
      .mockResolvedValueOnce({ data: { id: CONNECTION_ID, kind: "agent" }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    const { updateConnectionModules } = await import("../connections");
    const result = await updateConnectionModules(
      validUpdate({ requestTemplate: '{"input":"{{user_input}}"}', modules: [] })
    );
    expect(result).toEqual({ ok: true });
    expect(builder.update).toHaveBeenCalledWith({
      request_template: { input: "{{user_input}}" },
      optimizable_prompts: null,
    });
  });

  it("rejects a dataset connection", async () => {
    builder.maybeSingle.mockResolvedValueOnce({
      data: { id: CONNECTION_ID, kind: "dataset" },
      error: null,
    });
    const { updateConnectionModules } = await import("../connections");
    expect(await updateConnectionModules(validUpdate())).toEqual({
      error: "Only agent connections have Modules",
    });
  });
});

// --- listConnections ---

describe("listConnections", () => {
  it("returns empty array when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
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

// --- deleteConnection (#225) ---

describe("deleteConnection", () => {
  it("returns error when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
    const { deleteConnection } = await import("../connections");
    expect(await deleteConnection(CONNECTION_ID)).toEqual({ error: "Not authenticated" });
  });

  it("rejects non-contributors", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "u", orgId: "o", role: "member", canWrite: false });
    const { deleteConnection } = await import("../connections");
    expect(await deleteConnection(CONNECTION_ID)).toEqual({
      error: "Only contributors can delete connections",
    });
    expect(builder.delete).not.toHaveBeenCalled();
  });

  it("returns not-found for a connection outside the team", async () => {
    builder.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const { deleteConnection } = await import("../connections");
    expect(await deleteConnection(CONNECTION_ID)).toEqual({ error: "Connection not found" });
    expect(builder.delete).not.toHaveBeenCalled();
  });

  it("blocks the delete while an optimization run is active", async () => {
    builder.maybeSingle.mockResolvedValueOnce({ data: { id: CONNECTION_ID }, error: null });
    // First (and only) blocker query — the active-run count — returns a hit.
    builder._queue = [{ count: 1 }];
    const { deleteConnection } = await import("../connections");
    const result = await deleteConnection(CONNECTION_ID);
    expect(result).toEqual({
      error:
        "An optimization run is currently using this connection — wait for it to finish before deleting.",
    });
    expect(builder.in).toHaveBeenCalledWith("status", ["queued", "running"]);
    expect(builder.delete).not.toHaveBeenCalled();
  });

  it("blocks the delete while an enabled schedule references it", async () => {
    builder.maybeSingle.mockResolvedValueOnce({ data: { id: CONNECTION_ID }, error: null });
    // No active run, then an enabled-schedule count hit.
    builder._queue = [{ count: 0 }, { count: 1 }];
    const { deleteConnection } = await import("../connections");
    const result = await deleteConnection(CONNECTION_ID);
    expect(result).toEqual({
      error: "This connection is used by an active schedule — disable or delete the schedule first.",
    });
    expect(builder.eq).toHaveBeenCalledWith("enabled", true);
    expect(builder.delete).not.toHaveBeenCalled();
  });

  it("cascades the delete (scoped to id + org) and fires analytics when nothing is live", async () => {
    builder.maybeSingle.mockResolvedValueOnce({ data: { id: CONNECTION_ID }, error: null });
    // active-run count = 0, enabled-schedule count = 0, no referenced runs to settle,
    // delete returns no error.
    builder._queue = [{ count: 0 }, { count: 0 }, { data: [] }, { error: null }];
    const { deleteConnection } = await import("../connections");
    const result = await deleteConnection(CONNECTION_ID);
    expect(result).toEqual({ ok: true });
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("id", CONNECTION_ID);
    expect(builder.eq).toHaveBeenCalledWith("org_id", "org_abc");
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ name: "connection.deleted", props: { connection_id: CONNECTION_ID } }),
      { userId: "user_abc" }
    );
  });

  it("settles every terminal optimization run before cascading the delete", async () => {
    builder.maybeSingle.mockResolvedValueOnce({ data: { id: CONNECTION_ID }, error: null });
    // No active run / enabled schedule, two terminal runs to settle, then a clean delete.
    builder._queue = [
      { count: 0 },
      { count: 0 },
      { data: [{ id: "run_1" }, { id: "run_2" }] },
      { error: null },
    ];
    const { deleteConnection } = await import("../connections");
    expect(await deleteConnection(CONNECTION_ID)).toEqual({ ok: true });
    // Each referenced run is settled so the cascade can't strand its reservation.
    expect(builder.rpc).toHaveBeenCalledWith("settle_optimization_run", { p_run_id: "run_1" });
    expect(builder.rpc).toHaveBeenCalledWith("settle_optimization_run", { p_run_id: "run_2" });
    expect(builder.delete).toHaveBeenCalled();
  });

  it("returns an error when the delete fails", async () => {
    builder.maybeSingle.mockResolvedValueOnce({ data: { id: CONNECTION_ID }, error: null });
    builder._queue = [{ count: 0 }, { count: 0 }, { data: [] }, { error: { message: "db" } }];
    const { deleteConnection } = await import("../connections");
    expect(await deleteConnection(CONNECTION_ID)).toEqual({ error: "Failed to delete connection" });
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

// --- getConnectionDeletionImpact (#225) ---

describe("getConnectionDeletionImpact", () => {
  it("returns error when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
    const { getConnectionDeletionImpact } = await import("../connections");
    expect(await getConnectionDeletionImpact(CONNECTION_ID)).toEqual({ error: "Not authenticated" });
  });

  it("returns not-found for a connection outside the team", async () => {
    builder.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const { getConnectionDeletionImpact } = await import("../connections");
    expect(await getConnectionDeletionImpact(CONNECTION_ID)).toEqual({ error: "Connection not found" });
  });

  it("reports a deletable connection with no dependents", async () => {
    builder.maybeSingle.mockResolvedValueOnce({ data: { id: CONNECTION_ID, name: "Orphan" }, error: null });
    // Every count query falls back to _result with count 0 → unblocked, zero counts.
    builder._result = { count: 0 };
    const { getConnectionDeletionImpact } = await import("../connections");
    expect(await getConnectionDeletionImpact(CONNECTION_ID)).toEqual({
      name: "Orphan",
      schedules: 0,
      optimizationRuns: 0,
      blockReason: null,
    });
  });

  it("surfaces a block reason and the dependent counts when work is live", async () => {
    builder.maybeSingle.mockResolvedValueOnce({ data: { id: CONNECTION_ID, name: "Busy" }, error: null });
    // Every count query returns 1: totals are 1, and the active-run blocker fires.
    builder._result = { count: 1 };
    const { getConnectionDeletionImpact } = await import("../connections");
    expect(await getConnectionDeletionImpact(CONNECTION_ID)).toEqual({
      name: "Busy",
      schedules: 1,
      optimizationRuns: 1,
      blockReason:
        "An optimization run is currently using this connection — wait for it to finish before deleting.",
    });
  });
});
