import { describe, it, expect, vi, beforeEach } from "vitest";

// Coverage for the loader helpers (loadConnection/loadRubric/loadCandidatePrompts/loadCandidate/
// loadRun/loadMinibatchFeedback) that activities.rollout*.test.ts and activities.propose.test.ts
// exercise only on their happy paths. These aren't exported, so they're driven indirectly through
// the public Activities that call them (rolloutCandidate reaches loadConnection/loadRubric/
// loadCandidatePrompts/loadRun; proposeCandidate reaches loadCandidate/loadMinibatchFeedback).

let queues: Record<string, Array<{ data: unknown; error: unknown }>>;
let cursors: Record<string, number>;

function chainFor(table: string) {
  const q = queues[table] ?? [];
  const next = () => q[cursors[table]++] ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "order", "update", "insert", "returns"]) {
    chain[k] = () => chain;
  }
  chain.maybeSingle = () => Promise.resolve(next());
  chain.single = () => Promise.resolve(next());
  chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(next()).then(res, rej);
  return chain;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => chainFor(t), rpc: vi.fn() }),
}));

vi.mock("../log.js", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { mockResolveProviderKey } = vi.hoisted(() => ({ mockResolveProviderKey: vi.fn() }));
vi.mock("../providers/resolve-key.js", () => ({
  resolveProviderKey: mockResolveProviderKey,
  MISSING_PROVIDER_KEY_MESSAGE: "no key",
}));

const { mockPropose, mockCreateProviderForModel } = vi.hoisted(() => ({
  mockPropose: vi.fn(),
  mockCreateProviderForModel: vi.fn(),
}));
vi.mock("../providers/factory.js", () => ({
  createProviderForModel: mockCreateProviderForModel,
  createProvider: mockCreateProviderForModel,
}));

vi.mock("../providers/managed-meter.js", async (importActual) => {
  const actual = await importActual<typeof import("../providers/managed-meter.js")>();
  return { ...actual, createManagedMeter: vi.fn() };
});

const { mockInvokeAgent } = vi.hoisted(() => ({ mockInvokeAgent: vi.fn() }));
vi.mock("../agent.js", async (importActual) => {
  const actual = await importActual<typeof import("../agent.js")>();
  return { ...actual, invokeAgent: mockInvokeAgent };
});

vi.mock("../evaluator.js", () => ({ evaluateRun: vi.fn() }));
vi.mock("./scoring.js", () => ({ seedPromptsFor: () => ({}), perInstanceScores: vi.fn(() => ({})) }));

import { rolloutCandidate, proposeCandidate } from "./activities.js";
import { PARETO } from "./phase.js";

const REFLECT_MODEL = "claude-sonnet-4-6";

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "opt_1",
    org_id: "org_1",
    connection_id: "conn_1",
    rubric_id: "rubric_1",
    eval_type: "tabular",
    reflect_model: REFLECT_MODEL,
    budget_rollouts: 10,
    max_iters: 5,
    plateau_patience: null,
    pause_max_wait_minutes: 60,
    probe_interval_seconds: 30,
    ...overrides,
  };
}

const connectionRow = {
  id: "conn_1",
  kind: "agent",
  agent_kind: "customer",
  provider: "custom",
  endpoint: "https://example.com",
  auth_header: "Authorization",
  auth_secret_id: null,
  request_template: {},
  response_path: "output",
  target_model: null,
  optimizable_prompts: [{ name: "main" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  queues = {};
  cursors = {
    optimization_runs: 0,
    optimization_candidates: 0,
    optimization_rollouts: 0,
    connections: 0,
    rubrics: 0,
    rollout_results: 0,
    optimization_inputs: 0,
  };
  mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-byo" });
  mockCreateProviderForModel.mockReturnValue({ propose: mockPropose });
  mockPropose.mockResolvedValue({ prompt: "better", usage: { model: REFLECT_MODEL } });
});

const ROLLOUT_INPUT = { optRunId: "opt_1", candidateId: "cand_1", phase: PARETO } as const;

describe("loadRun (via rolloutCandidate)", () => {
  it("throws 'Optimization run not found' when the row is missing", async () => {
    queues = { optimization_runs: [{ data: null, error: null }, { data: null, error: null }] };
    await expect(rolloutCandidate(ROLLOUT_INPUT)).rejects.toThrow("Optimization run not found");
  });

  it("throws with the DB error message when the run query fails", async () => {
    queues = {
      optimization_runs: [
        { data: null, error: null },
        { data: null, error: { message: "connection reset" } },
      ],
    };
    await expect(rolloutCandidate(ROLLOUT_INPUT)).rejects.toThrow(
      "Failed to load optimization run: connection reset",
    );
  });
});

describe("loadConnection (via rolloutCandidate)", () => {
  it("throws 'Connection not found' when the row is missing", async () => {
    queues = {
      optimization_runs: [{ data: null, error: null }, { data: runRow(), error: null }],
      connections: [{ data: null, error: null }],
    };
    await expect(rolloutCandidate(ROLLOUT_INPUT)).rejects.toThrow("Connection not found");
  });

  it("throws with the DB error message when the connection query fails", async () => {
    queues = {
      optimization_runs: [{ data: null, error: null }, { data: runRow(), error: null }],
      connections: [{ data: null, error: { message: "timeout" } }],
    };
    await expect(rolloutCandidate(ROLLOUT_INPUT)).rejects.toThrow(
      "Failed to load connection: timeout",
    );
  });

  it("rejects a non-agent Connection", async () => {
    queues = {
      optimization_runs: [{ data: null, error: null }, { data: runRow(), error: null }],
      connections: [{ data: { ...connectionRow, kind: "dataset" }, error: null }],
    };
    await expect(rolloutCandidate(ROLLOUT_INPUT)).rejects.toThrow(
      "Optimization requires an agent Connection",
    );
  });
});

describe("loadRubric (via rolloutCandidate)", () => {
  it("throws 'Rubric not found' when the row is missing", async () => {
    queues = {
      optimization_runs: [{ data: null, error: null }, { data: runRow(), error: null }],
      connections: [{ data: connectionRow, error: null }],
      rubrics: [{ data: null, error: null }],
    };
    await expect(rolloutCandidate(ROLLOUT_INPUT)).rejects.toThrow("Rubric not found");
  });

  it("throws with the DB error message when the rubric query fails", async () => {
    queues = {
      optimization_runs: [{ data: null, error: null }, { data: runRow(), error: null }],
      connections: [{ data: connectionRow, error: null }],
      rubrics: [{ data: null, error: { message: "db down" } }],
    };
    await expect(rolloutCandidate(ROLLOUT_INPUT)).rejects.toThrow(
      "Failed to load rubric: db down",
    );
  });
});

describe("loadCandidatePrompts (via rolloutCandidate)", () => {
  it("throws 'Candidate not found' when the row is missing", async () => {
    queues = {
      optimization_runs: [{ data: null, error: null }, { data: runRow(), error: null }],
      connections: [{ data: connectionRow, error: null }],
      rubrics: [
        {
          data: { name: "R", scenario_description: "d", expected_outcome: "e", grounding_context: null, criteria: [] },
          error: null,
        },
      ],
      optimization_candidates: [{ data: null, error: null }],
    };
    await expect(rolloutCandidate(ROLLOUT_INPUT)).rejects.toThrow("Candidate not found");
  });

  it("throws with the DB error message when the candidate-prompts query fails", async () => {
    queues = {
      optimization_runs: [{ data: null, error: null }, { data: runRow(), error: null }],
      connections: [{ data: connectionRow, error: null }],
      rubrics: [
        {
          data: { name: "R", scenario_description: "d", expected_outcome: "e", grounding_context: null, criteria: [] },
          error: null,
        },
      ],
      optimization_candidates: [{ data: null, error: { message: "boom" } }],
    };
    await expect(rolloutCandidate(ROLLOUT_INPUT)).rejects.toThrow(
      "Failed to load candidate: boom",
    );
  });
});

const PROPOSE_INPUT = {
  optRunId: "opt_1",
  parentCandidateId: "cand_parent",
  targetModule: "system",
  iteration: 1,
};

describe("loadCandidate (via proposeCandidate)", () => {
  it("throws 'Candidate not found' when the parent row is missing", async () => {
    queues = {
      optimization_runs: [{ data: null, error: null }, { data: runRow(), error: null }],
      optimization_candidates: [{ data: null, error: null }, { data: null, error: null }],
    };
    await expect(proposeCandidate(PROPOSE_INPUT)).rejects.toThrow("Candidate not found");
  });
});

describe("loadMinibatchFeedback (via proposeCandidate)", () => {
  it("builds a ReflectionExample per minibatch rollout, joining results and the original input", async () => {
    queues = {
      optimization_runs: [{ data: null, error: null }, { data: runRow(), error: null }],
      optimization_candidates: [
        { data: null, error: null }, // no existing child
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null }, // parent
        { data: { id: "cand_child" }, error: null }, // insert
      ],
      optimization_rollouts: [
        {
          data: [
            { id: "rollout_0", instance_index: 0, agent_output: "output 0" },
            { id: "rollout_1", instance_index: 1, agent_output: "output 1" },
          ],
          error: null,
        },
      ],
      rollout_results: [
        {
          data: [
            { rollout_id: "rollout_0", criterion_name: "accuracy", score: 1, reasoning: "great" },
            { rollout_id: "rollout_1", criterion_name: "accuracy", score: 0, reasoning: "bad" },
          ],
          error: null,
        },
      ],
      optimization_inputs: [
        {
          data: [
            { instance_index: 0, user_input: "hi 0" },
            { instance_index: 1, user_input: "hi 1" },
          ],
          error: null,
        },
      ],
    };

    await proposeCandidate(PROPOSE_INPUT);

    expect(mockPropose).toHaveBeenCalledWith(
      expect.objectContaining({
        examples: [
          {
            userInput: "hi 0",
            agentOutput: "output 0",
            criteria: [{ name: "accuracy", score: 1, reasoning: "great" }],
          },
          {
            userInput: "hi 1",
            agentOutput: "output 1",
            criteria: [{ name: "accuracy", score: 0, reasoning: "bad" }],
          },
        ],
      }),
    );
  });

  it("returns no examples (and skips further reads) when there are no minibatch rollouts yet", async () => {
    queues = {
      optimization_runs: [{ data: null, error: null }, { data: runRow(), error: null }],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
        { data: { id: "cand_child" }, error: null },
      ],
      optimization_rollouts: [{ data: [], error: null }],
    };

    await proposeCandidate(PROPOSE_INPUT);

    expect(mockPropose).toHaveBeenCalledWith(expect.objectContaining({ examples: [] }));
  });

  it("throws with the DB error message when the minibatch-rollouts query fails", async () => {
    queues = {
      optimization_runs: [{ data: null, error: null }, { data: runRow(), error: null }],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
      ],
      optimization_rollouts: [{ data: null, error: { message: "rollouts unreachable" } }],
    };

    await expect(proposeCandidate(PROPOSE_INPUT)).rejects.toThrow(
      "Failed to load minibatch rollouts: rollouts unreachable",
    );
  });

  it("throws with the DB error message when the rollout-results query fails", async () => {
    queues = {
      optimization_runs: [{ data: null, error: null }, { data: runRow(), error: null }],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
      ],
      optimization_rollouts: [
        { data: [{ id: "rollout_0", instance_index: 0, agent_output: "o" }], error: null },
      ],
      rollout_results: [{ data: null, error: { message: "results unreachable" } }],
    };

    await expect(proposeCandidate(PROPOSE_INPUT)).rejects.toThrow(
      "Failed to load rollout results: results unreachable",
    );
  });

  it("throws with the DB error message when the instances query fails", async () => {
    queues = {
      optimization_runs: [{ data: null, error: null }, { data: runRow(), error: null }],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
      ],
      optimization_rollouts: [
        { data: [{ id: "rollout_0", instance_index: 0, agent_output: "o" }], error: null },
      ],
      rollout_results: [{ data: [], error: null }],
      optimization_inputs: [{ data: null, error: { message: "inputs unreachable" } }],
    };

    await expect(proposeCandidate(PROPOSE_INPUT)).rejects.toThrow(
      "Failed to load instances: inputs unreachable",
    );
  });
});
