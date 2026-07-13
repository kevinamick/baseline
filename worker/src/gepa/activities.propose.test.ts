import { describe, it, expect, vi, beforeEach } from "vitest";
import { ManagedSpendCapExceeded } from "../providers/managed-meter.js";

// proposeCandidate (GEPA reflective mutation) and proposeSimpleCandidate (Simple Mode rewrite)
// share the same idempotency/race/metering shape; activities.byo-failure.test.ts already covers
// the BYO-key-rejected logging path for proposeCandidate. This file covers what's left: the
// idempotent-existing-child short-circuit, the happy generate-and-insert path, the
// insert-conflict race-retry fallback, an insert failure with no raced row, and managed
// metering (record() call + a cap-exceeded rethrow as terminal).
//
// Same query-queue harness as activities.byo-failure.test.ts: each table's terminal results are
// consumed in global call order via a per-table cursor, since a single Activity call touches the
// same table more than once (e.g. optimization_candidates: existing-check -> loadCandidate ->
// insert -> optional raced re-select).

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

const { mockPropose, mockComplete, mockCreateProviderForModel } = vi.hoisted(() => ({
  mockPropose: vi.fn(),
  mockComplete: vi.fn(),
  mockCreateProviderForModel: vi.fn(),
}));
vi.mock("../providers/factory.js", () => ({
  createProviderForModel: mockCreateProviderForModel,
  createProvider: mockCreateProviderForModel,
}));

const { mockCreateManagedMeter } = vi.hoisted(() => ({ mockCreateManagedMeter: vi.fn() }));
vi.mock("../providers/managed-meter.js", async (importActual) => {
  const actual = await importActual<typeof import("../providers/managed-meter.js")>();
  return { ...actual, createManagedMeter: mockCreateManagedMeter };
});

import { proposeCandidate, proposeSimpleCandidate } from "./activities.js";

const REFLECT_MODEL = "claude-sonnet-4-6";

function runRow() {
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queues = {};
  cursors = { optimization_runs: 0, optimization_candidates: 0, optimization_rollouts: 0 };
  mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-byo" });
  mockCreateProviderForModel.mockReturnValue({ propose: mockPropose, complete: mockComplete });
  mockPropose.mockResolvedValue({ prompt: "a better prompt", usage: { model: REFLECT_MODEL } });
  mockComplete.mockResolvedValue({ text: "a rewritten prompt", usage: { model: REFLECT_MODEL } });
});

const PROPOSE_INPUT = {
  optRunId: "opt_1",
  parentCandidateId: "cand_parent",
  targetModule: "system",
  iteration: 1,
};

const SIMPLE_INPUT = {
  optRunId: "opt_1",
  parentCandidateId: "cand_parent",
  targetModule: "system",
  round: 1,
  iteration: 1,
  operatorSeed: 0.1,
};

describe("proposeCandidate", () => {
  it("returns the already-persisted child without reflecting again (idempotent retry)", async () => {
    queues = {
      optimization_candidates: [{ data: { id: "cand_existing" }, error: null }],
    };
    const result = await proposeCandidate(PROPOSE_INPUT);
    expect(result).toEqual({ childCandidateId: "cand_existing" });
    expect(mockPropose).not.toHaveBeenCalled();
  });

  it("throws when the existing-child check errors", async () => {
    queues = {
      optimization_candidates: [{ data: null, error: { message: "index corrupt" } }],
    };
    await expect(proposeCandidate(PROPOSE_INPUT)).rejects.toThrow(
      "Failed to check existing candidate: index corrupt",
    );
  });

  it("throws when loadCandidate (the parent) errors", async () => {
    queues = {
      optimization_runs: [
        { data: null, error: null },
        { data: runRow(), error: null },
      ],
      optimization_candidates: [
        { data: null, error: null },
        { data: null, error: { message: "parent lookup failed" } },
      ],
    };
    await expect(proposeCandidate(PROPOSE_INPUT)).rejects.toThrow(
      "Failed to load candidate: parent lookup failed",
    );
  });

  it("converts a reflection managed-meter creation failure into a terminal failure", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    const { ManagedPaymentBlockedError } = await vi.importActual<
      typeof import("../providers/managed-meter.js")
    >("../providers/managed-meter.js");
    mockCreateManagedMeter.mockRejectedValue(new ManagedPaymentBlockedError());
    queues = {
      optimization_runs: [
        { data: null, error: null },
        { data: runRow(), error: null },
      ],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
      ],
      optimization_rollouts: [{ data: [], error: null }],
    };

    await expect(proposeCandidate(PROPOSE_INPUT)).rejects.toMatchObject({
      type: "MANAGED_SPEND_BLOCKED",
      nonRetryable: true,
    });
  });

  it("reflects on the parent's minibatch feedback and persists a new child", async () => {
    queues = {
      optimization_runs: [
        { data: null, error: null }, // touch
        { data: runRow(), error: null }, // loadRun
      ],
      optimization_candidates: [
        { data: null, error: null }, // no existing child
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null }, // parent
        { data: { id: "cand_child" }, error: null }, // insert
      ],
      optimization_rollouts: [{ data: [], error: null }], // no minibatch feedback yet
    };

    const result = await proposeCandidate(PROPOSE_INPUT);

    expect(result).toEqual({ childCandidateId: "cand_child" });
    expect(mockPropose).toHaveBeenCalledWith(
      expect.objectContaining({ targetModule: "system", currentPrompt: "seed" }),
    );
  });

  it("returns the raced sibling's id when the insert loses a concurrent race", async () => {
    queues = {
      optimization_runs: [
        { data: null, error: null },
        { data: runRow(), error: null },
      ],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
        { data: null, error: { message: "duplicate key" } }, // insert conflict
        { data: { id: "cand_raced" }, error: null }, // re-read finds the race winner
      ],
      optimization_rollouts: [{ data: [], error: null }],
    };

    const result = await proposeCandidate(PROPOSE_INPUT);
    expect(result).toEqual({ childCandidateId: "cand_raced" });
  });

  it("throws when the insert fails and no raced row is found", async () => {
    queues = {
      optimization_runs: [
        { data: null, error: null },
        { data: runRow(), error: null },
      ],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
        { data: null, error: { message: "insert failed" } },
        { data: null, error: null }, // re-read finds nothing either
      ],
      optimization_rollouts: [{ data: [], error: null }],
    };

    await expect(proposeCandidate(PROPOSE_INPUT)).rejects.toThrow(
      "Failed to persist child candidate: insert failed",
    );
  });

  it("fails closed (MANAGED_SPEND_BLOCKED) when reflection resolves to managed with no reservation (#410)", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockCreateManagedMeter.mockResolvedValue(null);
    queues = {
      optimization_runs: [
        { data: null, error: null },
        { data: runRow(), error: null },
      ],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
      ],
      optimization_rollouts: [{ data: [], error: null }],
    };

    await expect(proposeCandidate(PROPOSE_INPUT)).rejects.toMatchObject({
      type: "MANAGED_SPEND_BLOCKED",
      nonRetryable: true,
    });
    expect(mockPropose).not.toHaveBeenCalled();
  });

  it("meters the reflection call when the key resolves to managed", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    const record = vi.fn().mockResolvedValue(undefined);
    mockCreateManagedMeter.mockResolvedValue({ assertPriced: vi.fn(), record });
    queues = {
      optimization_runs: [
        { data: null, error: null },
        { data: runRow(), error: null },
      ],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
        { data: { id: "cand_child" }, error: null },
      ],
      optimization_rollouts: [{ data: [], error: null }],
    };

    await proposeCandidate(PROPOSE_INPUT);

    expect(record).toHaveBeenCalledWith({
      usage: { model: REFLECT_MODEL },
      callKind: "reflect",
    });
  });

  it("converts a managed-spend cap breach during reflection into a terminal failure", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockCreateManagedMeter.mockResolvedValue({
      assertPriced: vi.fn(),
      record: vi.fn().mockRejectedValue(new ManagedSpendCapExceeded(5, 6)),
    });
    queues = {
      optimization_runs: [
        { data: null, error: null },
        { data: runRow(), error: null },
      ],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
      ],
      optimization_rollouts: [{ data: [], error: null }],
    };

    await expect(proposeCandidate(PROPOSE_INPUT)).rejects.toMatchObject({
      type: "MANAGED_SPEND_BLOCKED",
      nonRetryable: true,
    });
  });
});

describe("proposeSimpleCandidate", () => {
  it("returns the already-persisted child without generating again (idempotent retry)", async () => {
    queues = {
      optimization_candidates: [{ data: { id: "cand_existing" }, error: null }],
    };
    const result = await proposeSimpleCandidate(SIMPLE_INPUT);
    expect(result).toEqual({ childCandidateId: "cand_existing" });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("throws when the existing-child check errors", async () => {
    queues = {
      optimization_candidates: [{ data: null, error: { message: "index corrupt" } }],
    };
    await expect(proposeSimpleCandidate(SIMPLE_INPUT)).rejects.toThrow(
      "Failed to check existing candidate: index corrupt",
    );
  });

  it("converts a generation managed-meter creation failure into a terminal failure", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    const { ManagedPaymentBlockedError } = await vi.importActual<
      typeof import("../providers/managed-meter.js")
    >("../providers/managed-meter.js");
    mockCreateManagedMeter.mockRejectedValue(new ManagedPaymentBlockedError());
    queues = {
      optimization_runs: [
        { data: null, error: null },
        { data: runRow(), error: null },
      ],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
      ],
    };

    await expect(proposeSimpleCandidate(SIMPLE_INPUT)).rejects.toMatchObject({
      type: "MANAGED_SPEND_BLOCKED",
      nonRetryable: true,
    });
  });

  it("applies a rewrite operator to the parent prompt and persists a new child", async () => {
    queues = {
      optimization_runs: [
        { data: null, error: null },
        { data: runRow(), error: null },
      ],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
        { data: { id: "cand_child" }, error: null },
      ],
    };

    const result = await proposeSimpleCandidate(SIMPLE_INPUT);

    expect(result).toEqual({ childCandidateId: "cand_child" });
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({ model: REFLECT_MODEL, maxTokens: 8192 }),
    );
  });

  it("throws rather than installing an empty generated prompt", async () => {
    mockComplete.mockResolvedValue({ text: "   ", usage: { model: REFLECT_MODEL } });
    queues = {
      optimization_runs: [
        { data: null, error: null },
        { data: runRow(), error: null },
      ],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
      ],
    };

    await expect(proposeSimpleCandidate(SIMPLE_INPUT)).rejects.toThrow(
      "Generation model returned an empty prompt",
    );
  });

  it("returns the raced sibling's id when the insert loses a concurrent race", async () => {
    queues = {
      optimization_runs: [
        { data: null, error: null },
        { data: runRow(), error: null },
      ],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
        { data: null, error: { message: "duplicate key" } },
        { data: { id: "cand_raced" }, error: null },
      ],
    };

    const result = await proposeSimpleCandidate(SIMPLE_INPUT);
    expect(result).toEqual({ childCandidateId: "cand_raced" });
  });

  it("throws when the insert fails and no raced row is found", async () => {
    queues = {
      optimization_runs: [
        { data: null, error: null },
        { data: runRow(), error: null },
      ],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
        { data: null, error: { message: "insert failed" } },
        { data: null, error: null },
      ],
    };

    await expect(proposeSimpleCandidate(SIMPLE_INPUT)).rejects.toThrow(
      "Failed to persist simple child candidate: insert failed",
    );
  });

  it("fails closed (MANAGED_SPEND_BLOCKED) when generation resolves to managed with no reservation (#410)", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockCreateManagedMeter.mockResolvedValue(null);
    queues = {
      optimization_runs: [
        { data: null, error: null },
        { data: runRow(), error: null },
      ],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
      ],
    };

    await expect(proposeSimpleCandidate(SIMPLE_INPUT)).rejects.toMatchObject({
      type: "MANAGED_SPEND_BLOCKED",
      nonRetryable: true,
    });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("meters the generation call when the key resolves to managed", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    const record = vi.fn().mockResolvedValue(undefined);
    mockCreateManagedMeter.mockResolvedValue({ assertPriced: vi.fn(), record });
    queues = {
      optimization_runs: [
        { data: null, error: null },
        { data: runRow(), error: null },
      ],
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { system: "seed" }, generation: 0 }, error: null },
        { data: { id: "cand_child" }, error: null },
      ],
    };

    await proposeSimpleCandidate(SIMPLE_INPUT);

    expect(record).toHaveBeenCalledWith({
      usage: { model: REFLECT_MODEL },
      callKind: "reflect",
    });
  });
});
