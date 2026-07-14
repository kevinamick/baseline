import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---
// rolloutCandidate (the biggest, least-covered Activity) touches: optimization_runs (heartbeat +
// loadRun), connections (loadConnection), rubrics (loadRubric), optimization_candidates
// (loadCandidatePrompts), optimization_inputs (the frozen instance query), optimization_rollouts
// (per-instance upsert), and rollout_results (judge persistence), plus the RPC-backed
// getAuthValue. Each table gets a thin stub keyed off fixed test state — no cursor bookkeeping
// needed since this suite (unlike activities.byo-failure.test.ts) doesn't retry the same table
// shape twice per test.
//
// This file covers the CUSTOMER-ENDPOINT (non-managed) path: invokeAgent, the AgentEndpointError
// re-tag, and the judge BYO-failure logging. The Managed Agent branch (target key resolution,
// metering, the no-reservation guard) is covered separately in activities.rollout-managed.test.ts.

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

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
  } as Record<string, unknown> | null,
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
  } as Record<string, unknown> | null,
  rubricRow: {
    name: "Support quality",
    scenario_description: "desc",
    expected_outcome: "outcome",
    grounding_context: null,
    criteria: [{ name: "accuracy", weight: 1 }],
  } as Record<string, unknown> | null,
  candidateRow: { prompts: { main: "seed prompt" } } as Record<string, unknown> | null,
  instances: [
    { instance_index: 0, user_input: "hi 0", expected_output: "exp 0", retrieval_context: null },
    { instance_index: 1, user_input: "hi 1", expected_output: "exp 1", retrieval_context: null },
  ] as Array<Record<string, unknown>>,
  rolloutUpserts: [] as Array<Record<string, unknown>>,
  resultsUpserts: [] as Array<Record<string, unknown>>,
  rolloutUpsertError: null as { message: string } | null,
  resultsUpsertError: null as { message: string } | null,
  instancesError: null as { message: string } | null,
  limitCalls: [] as number[],
};

function makeFrom(table: string) {
  if (table === "optimization_runs") {
    return {
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
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
  if (table === "rubrics") {
    return {
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: state.rubricRow, error: null }) }),
      }),
    };
  }
  if (table === "optimization_candidates") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: state.candidateRow, error: null }),
        }),
      }),
    };
  }
  if (table === "optimization_inputs") {
    const chain = {
      eq: () => chain,
      order: () => chain,
      limit: (n: number) => {
        state.limitCalls.push(n);
        return chain;
      },
      then: (resolve: (v: unknown) => unknown) =>
        resolve(
          state.instancesError
            ? { data: null, error: state.instancesError }
            : { data: state.instances, error: null },
        ),
    };
    return { select: () => chain };
  }
  if (table === "optimization_rollouts") {
    return {
      upsert: (payload: Record<string, unknown>) => {
        state.rolloutUpserts.push(payload);
        return {
          select: () => ({
            single: () =>
              Promise.resolve(
                state.rolloutUpsertError
                  ? { data: null, error: state.rolloutUpsertError }
                  : { data: { id: `rollout-${payload.instance_index}` }, error: null },
              ),
          }),
        };
      },
    };
  }
  if (table === "rollout_results") {
    return {
      upsert: (payload: Array<Record<string, unknown>>) => {
        state.resultsUpserts.push(...payload);
        return Promise.resolve(
          state.resultsUpsertError ? { error: state.resultsUpsertError } : { error: null },
        );
      },
    };
  }
  throw new Error(`Unexpected table in test: ${table}`);
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => makeFrom(t), rpc: mockRpc }),
}));

vi.mock("../log.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { mockResolveProviderKey } = vi.hoisted(() => ({ mockResolveProviderKey: vi.fn() }));
vi.mock("../providers/resolve-key.js", () => ({
  resolveProviderKey: mockResolveProviderKey,
  MISSING_PROVIDER_KEY_MESSAGE: "no key",
}));

const { mockCreateProviderForModel } = vi.hoisted(() => ({ mockCreateProviderForModel: vi.fn() }));
vi.mock("../providers/factory.js", () => ({
  createProviderForModel: mockCreateProviderForModel,
  createProvider: mockCreateProviderForModel,
}));

const { mockCreateManagedMeter } = vi.hoisted(() => ({ mockCreateManagedMeter: vi.fn() }));
vi.mock("../providers/managed-meter.js", async (importActual) => {
  const actual = await importActual<typeof import("../providers/managed-meter.js")>();
  return { ...actual, createManagedMeter: mockCreateManagedMeter };
});

const { mockEvaluateRun } = vi.hoisted(() => ({ mockEvaluateRun: vi.fn() }));
vi.mock("../evaluator.js", () => ({ evaluateRun: mockEvaluateRun }));

const { mockInvokeAgent, mockInvokeManagedAgent } = vi.hoisted(() => ({
  mockInvokeAgent: vi.fn(),
  mockInvokeManagedAgent: vi.fn(),
}));
vi.mock("../agent.js", async (importActual) => {
  const actual = await importActual<typeof import("../agent.js")>();
  return {
    ...actual,
    invokeAgent: mockInvokeAgent,
    invokeManagedAgent: mockInvokeManagedAgent,
  };
});

vi.mock("./scoring.js", () => ({
  seedPromptsFor: () => ({}),
  perInstanceScores: vi.fn(() => ({ 0: 1, 1: 1 })),
}));

import { rolloutCandidate } from "./activities.js";
import { AgentEndpointError } from "../agent.js";
import { PARETO } from "./phase.js";
import { log } from "../log.js";
import { ProviderHttpError } from "../providers/http.js";

beforeEach(() => {
  vi.clearAllMocks();
  state.rolloutUpserts = [];
  state.resultsUpserts = [];
  state.rolloutUpsertError = null;
  state.resultsUpsertError = null;
  state.instancesError = null;
  state.limitCalls = [];
  state.instances = [
    { instance_index: 0, user_input: "hi 0", expected_output: "exp 0", retrieval_context: null },
    { instance_index: 1, user_input: "hi 1", expected_output: "exp 1", retrieval_context: null },
  ];
  state.connectionRow = {
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
  };
  mockRpc.mockResolvedValue({ data: "Bearer secret-value", error: null });
  mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-judge" });
  mockCreateProviderForModel.mockReturnValue({});
  mockInvokeAgent.mockImplementation(
    async (_conn: unknown, row: { row_index: number }) => `output for ${row.row_index}`,
  );
  mockEvaluateRun.mockResolvedValue({
    results: [
      { rowIndex: 0, criterionName: "accuracy", score: 1, reasoning: "great" },
      { rowIndex: 1, criterionName: "accuracy", score: 0.5, reasoning: "meh" },
    ],
    overallScore: 0.75,
  });
});

const INPUT = { optRunId: "opt_1", candidateId: "cand_1", phase: PARETO } as const;

describe("rolloutCandidate — customer endpoint (non-managed)", () => {
  it("invokes the agent per instance, persists rollouts, judges, and returns the score vector", async () => {
    const result = await rolloutCandidate(INPUT);

    expect(mockInvokeAgent).toHaveBeenCalledTimes(2);
    // Called with the connection, the invokable row, the decrypted auth value, and the candidate's prompts.
    expect(mockInvokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conn_1" }),
      expect.objectContaining({ row_index: 0, user_input: "hi 0" }),
      "Bearer secret-value",
      { main: "seed prompt" },
    );
    expect(state.rolloutUpserts).toHaveLength(2);
    expect(state.rolloutUpserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ candidate_id: "cand_1", instance_index: 0, phase: PARETO }),
        expect.objectContaining({ candidate_id: "cand_1", instance_index: 1, phase: PARETO }),
      ]),
    );
    expect(state.resultsUpserts).toHaveLength(2);
    expect(state.resultsUpserts[0]).toMatchObject({
      rollout_id: "rollout-0",
      criterion_name: "accuracy",
    });
    expect(result).toEqual({ overallScore: 0.75, instanceScores: { 0: 1, 1: 1 }, instancesRun: 2 });
  });

  it("throws when there are no frozen instances for the run", async () => {
    state.instances = [];
    await expect(rolloutCandidate(INPUT)).rejects.toThrow(
      "No frozen instances for optimization run",
    );
  });

  it("re-tags an AgentEndpointError as the circuit-breaker's marker type and never reaches the judge", async () => {
    mockInvokeAgent.mockRejectedValue(new AgentEndpointError("connection refused"));

    await expect(rolloutCandidate(INPUT)).rejects.toMatchObject({
      type: "AgentEndpointError",
    });
    expect(mockEvaluateRun).not.toHaveBeenCalled();
  });

  it("skips getAuthValue's RPC call when the connection has no auth_secret_id", async () => {
    state.connectionRow = { ...state.connectionRow, auth_secret_id: null };
    await rolloutCandidate(INPUT);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockInvokeAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      null,
      expect.anything(),
    );
  });

  it("throws when getAuthValue's RPC call errors", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "vault unreachable" } });
    await expect(rolloutCandidate(INPUT)).rejects.toThrow(
      "Failed to read Connection credential: vault unreachable",
    );
  });

  it("logs provider_key.byo_failed and rethrows when the BYO judge key is rejected", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-judge" });
    mockEvaluateRun.mockRejectedValue(
      new ProviderHttpError("anthropic", 401, '{"error":{"message":"invalid key"}}'),
    );

    await expect(rolloutCandidate(INPUT)).rejects.toThrow();

    expect(log.warn).toHaveBeenCalledWith(
      "Customer BYO provider key was rejected by the provider",
      expect.objectContaining({
        event: "provider_key.byo_failed",
        provider: "anthropic",
        org_id: "org_1",
        opt_run_id: "opt_1",
        status: 401,
      }),
    );
  });

  it("does NOT log provider_key.byo_failed when the managed judge key is rejected", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockCreateManagedMeter.mockResolvedValue({ assertPriced: vi.fn(), record: vi.fn() });
    mockEvaluateRun.mockRejectedValue(
      new ProviderHttpError("anthropic", 401, '{"error":{"message":"invalid key"}}'),
    );

    await expect(rolloutCandidate(INPUT)).rejects.toThrow();

    const byoLogged = vi
      .mocked(log.warn)
      .mock.calls.some((c) => (c[1] as { event?: string })?.event === "provider_key.byo_failed");
    expect(byoLogged).toBe(false);
  });

  it("throws when persisting rollout_results fails", async () => {
    state.resultsUpsertError = { message: "results write failed" };
    await expect(rolloutCandidate(INPUT)).rejects.toThrow(
      "Failed to persist rollout results: results write failed",
    );
  });

  it("throws when persisting a rollout upsert fails", async () => {
    state.rolloutUpsertError = { message: "rollout write failed" };
    await expect(rolloutCandidate(INPUT)).rejects.toThrow(
      "Failed to persist rollout: rollout write failed",
    );
  });

  it("throws when the instances query itself errors", async () => {
    state.instancesError = { message: "inputs table unreachable" };
    await expect(rolloutCandidate(INPUT)).rejects.toThrow(
      "Failed to load instances: inputs table unreachable",
    );
  });

  it("applies .limit() to the instances query for a minibatch phase", async () => {
    await rolloutCandidate({ optRunId: "opt_1", candidateId: "cand_1", phase: "minibatch", limit: 5 });
    expect(state.limitCalls).toEqual([5]);
  });

  it("fails terminally (PROVIDER_KEY_MISSING) when the judge key resolves to 'none'", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "none", key: "" });
    await expect(rolloutCandidate(INPUT)).rejects.toMatchObject({
      type: "PROVIDER_KEY_MISSING",
      nonRetryable: true,
    });
  });

  it("fails closed (MANAGED_SPEND_BLOCKED) when the judge resolves to managed with no reservation (#410)", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockCreateManagedMeter.mockResolvedValue(null);

    await expect(rolloutCandidate(INPUT)).rejects.toMatchObject({
      type: "MANAGED_SPEND_BLOCKED",
      nonRetryable: true,
    });
    expect(mockEvaluateRun).not.toHaveBeenCalled();
  });

  it("converts a judge managed-meter creation failure (e.g. payment blocked) into a terminal failure", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockCreateManagedMeter.mockRejectedValue(new Error("payment blocked simulation"));
    // rethrowManagedAsTerminal only converts the three managed-spend error classes; anything
    // else rethrows as-is, so use the real error class to hit the conversion branch.
    const { ManagedPaymentBlockedError } = await vi.importActual<
      typeof import("../providers/managed-meter.js")
    >("../providers/managed-meter.js");
    mockCreateManagedMeter.mockRejectedValue(new ManagedPaymentBlockedError());

    await expect(rolloutCandidate(INPUT)).rejects.toMatchObject({
      type: "MANAGED_SPEND_BLOCKED",
      nonRetryable: true,
    });
  });
});
