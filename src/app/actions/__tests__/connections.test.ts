import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { z } from "zod";
import type { UpdateManagedConnectionSchema } from "@/lib/validation/schemas";

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
const mockRunDatasetPreview = vi.fn();

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/connections/create", () => ({
  insertConnection: mockInsertConnection,
  MANAGED_MODULE_NAME: "prompt",
}));
vi.mock("@/lib/connections/preview", () => ({ runDatasetPreview: mockRunDatasetPreview }));
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

function validCustomDatasetConnection(overrides: Record<string, unknown> = {}) {
  return {
    type: "custom_dataset" as const,
    name: "Support logs",
    endpoint: "https://api.example.com/logs",
    authHeader: null,
    authValue: null,
    requestTemplate: "{}",
    responsePath: "rows",
    fieldMap: { userInput: "input", agentOutput: "output" },
    ...overrides,
  };
}

function validCustomDatasetPreview(overrides: Record<string, unknown> = {}) {
  return {
    type: "custom_dataset" as const,
    endpoint: "https://api.example.com/logs",
    authHeader: null,
    authValue: null,
    requestTemplate: "{}",
    responsePath: "rows",
    fieldMap: { userInput: "input", agentOutput: "output" },
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

  // Create-time SSRF defense-in-depth (#220, #314): a link-local / metadata / private-IP
  // endpoint must be refused by the real NewConnectionSchema at the server-action boundary —
  // not just by the pure endpointUrlError unit tests — for BOTH Connection types that carry a
  // tenant-supplied endpoint (agent + custom_dataset). This is the exact BVT-audited scenario
  // (a Free-plan tenant SSRF'd the prod worker via a Connection endpoint) exercised end to end
  // through createConnection, proving the gate runs before insertConnection is ever reached.
  describe("rejects a link-local/metadata/private endpoint at create time (#220, #314)", () => {
    const maliciousEndpoints = [
      "https://169.254.169.254/latest/meta-data/", // cloud metadata (the audited exploit host)
      "https://127.0.0.1/",
      "https://10.0.0.5/internal",
      "https://[::1]/",
      "https://metadata.google.internal/computeMetadata/v1/",
    ];

    for (const endpoint of maliciousEndpoints) {
      it(`rejects an agent connection targeting ${endpoint}`, async () => {
        const { createConnection } = await import("../connections");
        const result = await createConnection(validConnection({ endpoint }));
        expect(result).toHaveProperty("error");
        expect(mockInsertConnection).not.toHaveBeenCalled();
      });

      it(`rejects a custom_dataset connection targeting ${endpoint}`, async () => {
        const { createConnection } = await import("../connections");
        const result = await createConnection(validCustomDatasetConnection({ endpoint }));
        expect(result).toHaveProperty("error");
        expect(mockInsertConnection).not.toHaveBeenCalled();
      });
    }

    it("still accepts a legitimate public https endpoint (no false positive)", async () => {
      const { createConnection } = await import("../connections");
      const result = await createConnection(validCustomDatasetConnection());
      expect(result).toEqual({ connectionId: "conn_1" });
    });
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

  it("rejects a PostHog dataset connection whose host is not a PostHog host (#221)", async () => {
    const { createConnection } = await import("../connections");
    const result = await createConnection(validPosthogConnection({ host: "https://evil.example.com" }));
    expect(result).toEqual({ error: "PostHog host must be a posthog.com address" });
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
    expect(builder.in).toHaveBeenCalledWith("status", ["queued", "running", "paused"]);
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

// --- updateManagedConnection (#294) ---

const HAIKU = "claude-haiku-4-5-20251001";

function validManagedUpdate(
  overrides: Partial<z.input<typeof UpdateManagedConnectionSchema>> = {}
): z.input<typeof UpdateManagedConnectionSchema> {
  return {
    connectionId: CONNECTION_ID,
    prompt: "You classify refund requests.",
    targetModel: HAIKU,
    ...overrides,
  };
}

describe("updateManagedConnection", () => {
  it("rejects non-contributors", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "u", orgId: "o", role: "member", canWrite: false });
    const { updateManagedConnection } = await import("../connections");
    expect(await updateManagedConnection(validManagedUpdate())).toEqual({
      error: "Only contributors can edit connections",
    });
  });

  it("returns a validation error for an empty prompt", async () => {
    const { updateManagedConnection } = await import("../connections");
    expect(await updateManagedConnection(validManagedUpdate({ prompt: "" }))).toEqual({
      error: "Prompt is required",
    });
  });

  it("refuses to reshape a non-managed (external) agent through this path", async () => {
    builder.maybeSingle.mockResolvedValueOnce({
      data: { id: CONNECTION_ID, agent_kind: "external" },
      error: null,
    });
    const { updateManagedConnection } = await import("../connections");
    expect(await updateManagedConnection(validManagedUpdate())).toEqual({
      error: "Not a Managed Agent connection",
    });
    expect(builder.update).not.toHaveBeenCalled();
  });

  it("blocks the edit while an optimization run is active on the connection", async () => {
    builder.maybeSingle
      .mockResolvedValueOnce({ data: { id: CONNECTION_ID, agent_kind: "managed" }, error: null })
      .mockResolvedValueOnce({ data: { id: "run_1" }, error: null });
    const { updateManagedConnection } = await import("../connections");
    const result = await updateManagedConnection(validManagedUpdate());
    expect(result).toEqual({
      error:
        "An optimization run is currently using this connection — wait for it to finish before editing the prompt.",
    });
    expect(builder.in).toHaveBeenCalledWith("status", ["queued", "running", "paused"]);
    expect(builder.update).not.toHaveBeenCalled();
  });

  it("rewrites the single Module's seed + target model when no run is active", async () => {
    builder.maybeSingle
      .mockResolvedValueOnce({ data: { id: CONNECTION_ID, agent_kind: "managed" }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    const { updateManagedConnection } = await import("../connections");
    const result = await updateManagedConnection(validManagedUpdate({ prompt: "  Triage refunds.  " }));
    expect(result).toEqual({ ok: true });
    // The lone Module keeps the internal "prompt" name; its seed is the trimmed prompt. No template.
    expect(builder.update).toHaveBeenCalledWith({
      optimizable_prompts: [{ name: "prompt", seed: "Triage refunds." }],
      target_model: HAIKU,
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

// --- previewDatasetConnection (#39) ---

describe("previewDatasetConnection", () => {
  it("escalates an egress-blocked preview to log.error with the SSRF code", async () => {
    mockRunDatasetPreview.mockResolvedValue({ error: "endpoint", detail: "blocked: private address" });
    const { previewDatasetConnection } = await import("../connections");
    const { log } = await import("@/lib/logging/server");

    const result = await previewDatasetConnection(validPosthogConnection());

    expect(result).toEqual({ error: "endpoint", detail: "blocked: private address" });
    expect(log.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: "connection.preview_failed",
        provider: "posthog_dataset",
        error_code: "endpoint",
        detail: "blocked: private address",
      }),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs a non-endpoint failure at warn with its categorized code", async () => {
    mockRunDatasetPreview.mockResolvedValue({ error: "auth", detail: "HTTP 401" });
    const { previewDatasetConnection } = await import("../connections");
    const { log } = await import("@/lib/logging/server");

    await previewDatasetConnection(validPosthogConnection());

    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "connection.preview_failed", error_code: "auth" }),
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs an unmapped-rows success at info with the row count", async () => {
    mockRunDatasetPreview.mockResolvedValue({ rows: [{}, {}], warning: "no_columns_mapped" });
    const { previewDatasetConnection } = await import("../connections");
    const { log } = await import("@/lib/logging/server");

    await previewDatasetConnection(validPosthogConnection());

    expect(log.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "connection.preview_unmapped", provider: "posthog_dataset", row_count: 2 }),
    );
  });

  it("does not log when the preview succeeds with mapped rows", async () => {
    mockRunDatasetPreview.mockResolvedValue({ rows: [{ user_input: "hi", agent_output: "yo" }] });
    const { previewDatasetConnection } = await import("../connections");
    const { log } = await import("@/lib/logging/server");

    await previewDatasetConnection(validPosthogConnection());

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("refuses a non-contributor before running the preview", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: "user_abc", orgId: "org_abc", role: "member", canWrite: false });
    const { previewDatasetConnection } = await import("../connections");

    expect(await previewDatasetConnection(validPosthogConnection())).toEqual({ error: "forbidden" });
    expect(mockRunDatasetPreview).not.toHaveBeenCalled();
  });

  // Create-time SSRF defense-in-depth for the schedule wizard's "Test query" preview (#220,
  // #314): every other test in this describe block stubs mockRunDatasetPreview's *result*, which
  // would mask a schema gap — this proves the real DatasetPreviewSchema (reusing endpointField /
  // endpointUrlError, same as NewConnectionSchema) refuses a link-local/metadata endpoint BEFORE
  // runDatasetPreview (and therefore the worker adapter / safeFetch) is ever invoked. The preview
  // path is not just guarded at fetch time inside the adapter — it has its own create-time gate.
  it("rejects a link-local preview endpoint via schema before invoking runDatasetPreview (#220, #314)", async () => {
    const { previewDatasetConnection } = await import("../connections");
    const result = await previewDatasetConnection(
      validCustomDatasetPreview({ endpoint: "https://169.254.169.254/latest/meta-data/" })
    );
    expect(result).toEqual({ error: "config", detail: expect.any(String) });
    expect(mockRunDatasetPreview).not.toHaveBeenCalled();
  });

  it("accepts a legitimate custom_dataset preview and delegates to runDatasetPreview", async () => {
    mockRunDatasetPreview.mockResolvedValue({ rows: [{ user_input: "hi", agent_output: "yo" }] });
    const { previewDatasetConnection } = await import("../connections");
    const result = await previewDatasetConnection(validCustomDatasetPreview());
    expect(result).toEqual({ rows: [{ user_input: "hi", agent_output: "yo" }] });
    expect(mockRunDatasetPreview).toHaveBeenCalled();
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
    expect(builder.in).toHaveBeenCalledWith("status", ["queued", "running", "paused"]);
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
