import { describe, it, expect, vi, beforeEach } from "vitest";

// probeEndpoint (#102): a single cheap health-check call against the run's agent endpoint,
// called by the workflow's pause-and-wait loop. It returns a verdict rather than throwing for
// the expected "still down" case, and rethrows anything else so the workflow treats it as
// "still down" too (see workflow.loop.test.ts for the workflow-side behavior).

const state = {
  runRow: {
    id: "opt_1",
    org_id: "org_1",
    connection_id: "conn_1",
    rubric_id: "rubric_1",
    eval_type: "tabular",
    reflect_model: "claude-sonnet-4-6",
    budget_rollouts: 100,
    max_iters: 10,
    plateau_patience: null,
    pause_max_wait_minutes: 60,
    probe_interval_seconds: 60,
  } as Record<string, unknown>,
  connectionRow: {
    id: "conn_1",
    kind: "agent",
    agent_kind: "customer",
    provider: "custom",
    endpoint: "https://example.com/agent",
    auth_header: "Authorization",
    auth_secret_id: "sec_1",
    request_template: {},
    response_path: "output",
    target_model: null,
    optimizable_prompts: [{ name: "main" }],
  } as Record<string, unknown>,
};

function makeFrom(table: string) {
  if (table === "optimization_runs") {
    return {
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: state.runRow, error: null }) }),
      }),
    };
  }
  if (table === "connections") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: state.connectionRow, error: null }),
        }),
      }),
    };
  }
  throw new Error(`Unexpected table in test: ${table}`);
}

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => makeFrom(t), rpc: mockRpc }),
}));

vi.mock("../log.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { mockInvokeAgent } = vi.hoisted(() => ({ mockInvokeAgent: vi.fn() }));
vi.mock("../agent.js", async (importActual) => {
  const actual = await importActual<typeof import("../agent.js")>();
  return { ...actual, invokeAgent: mockInvokeAgent };
});

import { probeEndpoint } from "./activities.js";
import { AgentEndpointError } from "../agent.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockRpc.mockResolvedValue({ data: "Bearer secret-value", error: null });
});

describe("probeEndpoint", () => {
  it("reports healthy when the agent responds normally", async () => {
    mockInvokeAgent.mockResolvedValue("ack");
    const result = await probeEndpoint({ optRunId: "opt_1" });
    expect(result).toEqual({ healthy: true });
    expect(mockInvokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conn_1" }),
      expect.objectContaining({
        row_index: -1,
        user_input: expect.stringContaining("Health check"),
      }),
      "Bearer secret-value",
      null,
      expect.any(AbortSignal),
    );
  });

  it("reports unhealthy with the endpoint's message on an AgentEndpointError verdict", async () => {
    mockInvokeAgent.mockRejectedValue(new AgentEndpointError("connection refused"));
    const result = await probeEndpoint({ optRunId: "opt_1" });
    expect(result).toEqual({ healthy: false, message: "connection refused" });
  });

  it("rethrows a non-endpoint error rather than reporting a false verdict", async () => {
    mockInvokeAgent.mockRejectedValue(new Error("unexpected crash"));
    await expect(probeEndpoint({ optRunId: "opt_1" })).rejects.toThrow("unexpected crash");
  });
});
