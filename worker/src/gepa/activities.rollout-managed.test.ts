import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---
// The Managed Agent branch of rolloutCandidate (#290/#291): target_model validation, target-key
// resolution + metering, the no-reservation fail-closed guard, and BYO-target-key failure
// logging. Table stubs mirror activities.rollout.test.ts (the customer-endpoint sibling file).

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
  } as Record<string, unknown>,
  connectionRow: {
    id: "conn_1",
    kind: "agent",
    agent_kind: "managed",
    provider: null,
    endpoint: null,
    auth_header: null,
    auth_secret_id: null,
    request_template: null,
    response_path: null,
    target_model: "claude-sonnet-4-6",
    optimizable_prompts: [{ name: "main" }],
  } as Record<string, unknown>,
  rubricRow: {
    name: "Support quality",
    scenario_description: "desc",
    expected_outcome: "outcome",
    grounding_context: null,
    criteria: [{ name: "accuracy", weight: 1 }],
  } as Record<string, unknown>,
  candidateRow: { prompts: { main: "seed prompt" } } as Record<string, unknown>,
  instances: [
    { instance_index: 0, user_input: "hi 0", expected_output: "exp 0", retrieval_context: null },
  ] as Array<Record<string, unknown>>,
  rolloutUpserts: [] as Array<Record<string, unknown>>,
  resultsUpserts: [] as Array<Record<string, unknown>>,
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
      limit: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ data: state.instances, error: null }),
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
              Promise.resolve({ data: { id: `rollout-${payload.instance_index}` }, error: null }),
          }),
        };
      },
    };
  }
  if (table === "rollout_results") {
    return {
      upsert: (payload: Array<Record<string, unknown>>) => {
        state.resultsUpserts.push(...payload);
        return Promise.resolve({ error: null });
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
vi.mock("../providers/factory.js", () => ({ createProviderForModel: mockCreateProviderForModel }));

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
  perInstanceScores: vi.fn(() => ({ 0: 1 })),
}));

import { rolloutCandidate } from "./activities.js";
import { PARETO } from "./phase.js";
import { log } from "../log.js";
import { ManagedSpendCapExceeded } from "../providers/managed-meter.js";
import { ProviderHttpError } from "../providers/http.js";

beforeEach(() => {
  vi.clearAllMocks();
  state.rolloutUpserts = [];
  state.resultsUpserts = [];
  state.connectionRow = {
    id: "conn_1",
    kind: "agent",
    agent_kind: "managed",
    provider: null,
    endpoint: null,
    auth_header: null,
    auth_secret_id: null,
    request_template: null,
    response_path: null,
    target_model: "claude-sonnet-4-6",
    optimizable_prompts: [{ name: "main" }],
  };
  state.instances = [
    { instance_index: 0, user_input: "hi 0", expected_output: "exp 0", retrieval_context: null },
  ];
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockCreateProviderForModel.mockReturnValue({});
  mockInvokeManagedAgent.mockResolvedValue({
    text: "managed output",
    usage: { model: "claude-sonnet-4-6", inputTokens: 10, outputTokens: 10 },
  });
  mockEvaluateRun.mockResolvedValue({
    results: [{ rowIndex: 0, criterionName: "accuracy", score: 1, reasoning: "great" }],
    overallScore: 1,
  });
});

const INPUT = { optRunId: "opt_1", candidateId: "cand_1", phase: PARETO } as const;

describe("rolloutCandidate — Managed Agent target_model validation", () => {
  it("fails terminally (MANAGED_AGENT_CONFIG) when target_model is missing", async () => {
    state.connectionRow = { ...state.connectionRow, target_model: null };
    await expect(rolloutCandidate(INPUT)).rejects.toMatchObject({
      type: "MANAGED_AGENT_CONFIG",
      nonRetryable: true,
    });
    expect(mockInvokeManagedAgent).not.toHaveBeenCalled();
  });

  it("fails terminally (MANAGED_AGENT_CONFIG) when target_model is not a known Anthropic model", async () => {
    state.connectionRow = { ...state.connectionRow, target_model: "gpt-5" };
    await expect(rolloutCandidate(INPUT)).rejects.toMatchObject({
      type: "MANAGED_AGENT_CONFIG",
      nonRetryable: true,
    });
  });
});

describe("rolloutCandidate — Managed Agent target key resolution + metering", () => {
  it("runs the target on a BYO key unmetered (null meter, no record() call)", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-target" });

    const result = await rolloutCandidate(INPUT);

    expect(mockInvokeManagedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conn_1" }),
      expect.objectContaining({ row_index: 0 }),
      expect.anything(),
      { main: "seed prompt" },
    );
    expect(result.overallScore).toBe(1);
  });

  it("meters the managed target's token usage when the key is managed", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    const record = vi.fn().mockResolvedValue(undefined);
    mockCreateManagedMeter.mockResolvedValue({ assertPriced: vi.fn(), record });

    await rolloutCandidate(INPUT);

    expect(record).toHaveBeenCalledWith({
      usage: { model: "claude-sonnet-4-6", inputTokens: 10, outputTokens: 10 },
      callKind: "agent",
    });
  });

  it("fails closed (MANAGED_SPEND_BLOCKED) when the target resolves to managed with no reservation", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockCreateManagedMeter.mockResolvedValue(null);

    await expect(rolloutCandidate(INPUT)).rejects.toMatchObject({
      type: "MANAGED_SPEND_BLOCKED",
      nonRetryable: true,
    });
    expect(mockInvokeManagedAgent).not.toHaveBeenCalled();
  });

  it("converts a managed-spend cap breach from meter.record() into a terminal failure", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockCreateManagedMeter.mockResolvedValue({
      assertPriced: vi.fn(),
      record: vi.fn().mockRejectedValue(new ManagedSpendCapExceeded(10, 12)),
    });

    await expect(rolloutCandidate(INPUT)).rejects.toMatchObject({
      type: "MANAGED_SPEND_BLOCKED",
      nonRetryable: true,
    });
  });

  it("converts a target managed-meter creation failure (e.g. payment blocked) into a terminal failure", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    const { ManagedPaymentBlockedError } = await vi.importActual<
      typeof import("../providers/managed-meter.js")
    >("../providers/managed-meter.js");
    mockCreateManagedMeter.mockRejectedValue(new ManagedPaymentBlockedError());

    await expect(rolloutCandidate(INPUT)).rejects.toMatchObject({
      type: "MANAGED_SPEND_BLOCKED",
      nonRetryable: true,
    });
    expect(mockInvokeManagedAgent).not.toHaveBeenCalled();
  });

  it("logs provider_key.byo_failed and rethrows the raw error when the BYO target key is rejected", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-target" });
    const rejection = new ProviderHttpError("anthropic", 401, '{"error":{"message":"bad key"}}');
    mockInvokeManagedAgent.mockRejectedValue(rejection);

    await expect(rolloutCandidate(INPUT)).rejects.toBe(rejection);

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
});
