import { describe, it, expect, beforeEach, vi } from "vitest";

// mergeCandidates (system-aware merge, #84) shares proposeCandidate's idempotency/race shape
// (activities.propose.test.ts) but makes no LLM call — just two loadCandidate reads (the
// parents) feeding the pure combineModulePrompts (merge.ts) and one insert. Same query-queue
// harness convention as activities.propose.test.ts / activities.byo-failure.test.ts: each
// table's terminal results are consumed in call order via a per-table cursor. This harness
// also captures every `.insert(...)` payload so tests can assert the exact row persisted
// (parent_id/merged_from_id/generation/prompts) — propose's tests don't need this since they
// only assert on the returned id, but merge's whole point is which parent's prompt won each
// Module, so the inserted `prompts` shape is the thing worth pinning.

let queues: Record<string, Array<{ data: unknown; error: unknown }>>;
let cursors: Record<string, number>;
let insertedPayloads: Record<string, unknown>[];

function chainFor(table: string) {
  const q = queues[table] ?? [];
  const next = () => q[cursors[table]++] ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "order", "returns"]) {
    chain[k] = () => chain;
  }
  chain.update = () => chain;
  chain.insert = (payload: Record<string, unknown>) => {
    if (table === "optimization_candidates") insertedPayloads.push(payload);
    return chain;
  };
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

import { mergeCandidates } from "./activities.js";

const MERGE_INPUT = {
  optRunId: "opt_1",
  aCandidateId: "cand_a",
  aOverallScore: 0.8,
  bCandidateId: "cand_b",
  bOverallScore: 0.6,
  modules: ["classifier", "responder"],
  mergeIteration: -1,
};

beforeEach(() => {
  queues = {};
  cursors = { optimization_candidates: 0 };
  insertedPayloads = [];
});

describe("mergeCandidates", () => {
  it("returns the already-persisted hybrid without loading parents again (idempotent retry)", async () => {
    queues = {
      optimization_candidates: [{ data: { id: "hybrid_existing" }, error: null }],
    };
    const result = await mergeCandidates(MERGE_INPUT);
    expect(result).toEqual({ hybridCandidateId: "hybrid_existing" });
    expect(insertedPayloads).toEqual([]);
  });

  it("throws when the existing-hybrid check errors", async () => {
    queues = {
      optimization_candidates: [{ data: null, error: { message: "index corrupt" } }],
    };
    await expect(mergeCandidates(MERGE_INPUT)).rejects.toThrow(
      "Failed to check existing merged candidate: index corrupt",
    );
  });

  it("round-robins Modules from the higher-scoring parent first and persists the hybrid with both parent pointers", async () => {
    queues = {
      optimization_candidates: [
        { data: null, error: null }, // no existing hybrid
        { data: { prompts: { classifier: "A-classifier", responder: "A-responder" }, generation: 2 }, error: null }, // loadCandidate(a)
        { data: { prompts: { classifier: "B-classifier", responder: "B-responder" }, generation: 1 }, error: null }, // loadCandidate(b)
        { data: { id: "hybrid_1" }, error: null }, // insert
      ],
    };

    const result = await mergeCandidates(MERGE_INPUT);

    expect(result).toEqual({ hybridCandidateId: "hybrid_1" });
    expect(insertedPayloads).toEqual([
      {
        opt_run_id: "opt_1",
        parent_id: "cand_a", // a's overallScore (0.8) > b's (0.6) -> a is primary
        merged_from_id: "cand_b",
        generation: 3, // max(2, 1) + 1
        iteration: -1,
        target_module: "merge",
        prompts: {
          classifier: "A-classifier", // Module index 0 -> stronger parent (a)
          responder: "B-responder", // Module index 1 -> weaker parent (b)
        },
      },
    ]);
  });

  it("flips primary/secondary when b scores higher than a", async () => {
    queues = {
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { classifier: "A-classifier", responder: "A-responder" }, generation: 0 }, error: null },
        { data: { prompts: { classifier: "B-classifier", responder: "B-responder" }, generation: 0 }, error: null },
        { data: { id: "hybrid_2" }, error: null },
      ],
    };

    await mergeCandidates({ ...MERGE_INPUT, aOverallScore: 0.4, bOverallScore: 0.9 });

    expect(insertedPayloads[0]).toMatchObject({
      parent_id: "cand_b",
      merged_from_id: "cand_a",
      prompts: { classifier: "B-classifier", responder: "A-responder" },
    });
  });

  it("returns the raced sibling's id when the insert loses a concurrent race", async () => {
    queues = {
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { classifier: "A", responder: "A" }, generation: 0 }, error: null },
        { data: { prompts: { classifier: "B", responder: "B" }, generation: 0 }, error: null },
        { data: null, error: { message: "duplicate key" } }, // insert conflict
        { data: { id: "hybrid_raced" }, error: null }, // re-read finds the race winner
      ],
    };

    const result = await mergeCandidates(MERGE_INPUT);
    expect(result).toEqual({ hybridCandidateId: "hybrid_raced" });
  });

  it("throws when the insert fails and no raced row is found", async () => {
    queues = {
      optimization_candidates: [
        { data: null, error: null },
        { data: { prompts: { classifier: "A", responder: "A" }, generation: 0 }, error: null },
        { data: { prompts: { classifier: "B", responder: "B" }, generation: 0 }, error: null },
        { data: null, error: { message: "insert failed" } },
        { data: null, error: null }, // re-read finds nothing either
      ],
    };

    await expect(mergeCandidates(MERGE_INPUT)).rejects.toThrow(
      "Failed to persist merged candidate: insert failed",
    );
  });
});
