import { describe, it, expect, vi, beforeEach } from "vitest";
import { proposeCandidate } from "./activities.js";
import { resolveProviderKey } from "../providers/resolve-key.js";
import { createProviderForModel } from "../providers/factory.js";
import { createManagedMeter } from "../providers/managed-meter.js";
import { log } from "../log.js";
import { ProviderHttpError } from "../providers/http.js";

// Optimization-run BYO-key failure (#350-followup, extends the eval-worker behavior to the GEPA
// path). When an optimization provider call (judge / reflect / generation / Managed Agent target)
// is rejected on the Team's own key, the activity emits the same distinct provider_key.byo_failed
// event before rethrowing — and a managed-key failure does NOT. The Free fail-closed invariant on
// this path is enforced by resolveOptimizationKey (a terminal ApplicationFailure on "none", never a
// managed fallback) and is unit-tested via resolve-key.test.ts; here we cover the failure logging.
//
// proposeCandidate is the leanest provider-call activity (one reflect call), so it stands in for
// the shared logByoOptimizationKeyFailure wiring used by all four call sites.

const REFLECT_MODEL = "claude-sonnet-4-6"; // an anthropic model → providerForModel === "anthropic"

vi.mock("../log.js", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../providers/resolve-key.js", () => ({
  resolveProviderKey: vi.fn(),
  MISSING_PROVIDER_KEY_MESSAGE: "no key",
}));
vi.mock("../providers/factory.js", () => ({ createProviderForModel: vi.fn() }));
vi.mock("../providers/managed-meter.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../providers/managed-meter.js")>();
  return { ...actual, createManagedMeter: vi.fn() };
});

// Per-table terminal-result queues consumed in call order. proposeCandidate touches:
//   optimization_runs:        touch update (1) → loadRun maybeSingle (2)
//   optimization_candidates:  existing-check maybeSingle (1, null) → loadCandidate maybeSingle (2)
//   optimization_rollouts:    loadMinibatchFeedback returns [] → no further feedback reads
let queues: Record<string, Array<{ data: unknown; error: unknown }>>;
// Cursor per table, persisted ACROSS from() calls — each from() builds a fresh chain but the
// terminal results for a table are consumed in global call order, not reset per builder.
let cursors: Record<string, number>;

function chainFor(table: string) {
  const q = queues[table] ?? [];
  const next = () => q[cursors[table]++] ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};
  for (const k of [
    "select",
    "eq",
    "in",
    "order",
    "update",
    "insert",
    "returns",
  ]) {
    chain[k] = () => chain;
  }
  chain.maybeSingle = () => Promise.resolve(next());
  chain.single = () => Promise.resolve(next());
  // Awaiting the builder directly (touch's update().eq(), loadMinibatch's .returns()) consumes one.
  chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(next()).then(res, rej);
  return chain;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => chainFor(t), rpc: vi.fn() }),
}));

function seedQueues() {
  queues = {
    optimization_runs: [
      { data: null, error: null }, // touch update
      {
        data: {
          id: "opt_1",
          org_id: "org_free",
          connection_id: "conn_1",
          rubric_id: "rubric_1",
          eval_type: "tabular",
          reflect_model: REFLECT_MODEL,
          budget_rollouts: 10,
          max_iters: 5,
          plateau_patience: null,
          pause_max_wait_minutes: 60,
          probe_interval_seconds: 30,
        },
        error: null,
      },
    ],
    optimization_candidates: [
      { data: null, error: null }, // no existing child for this iteration
      { data: { prompts: { system: "seed" }, generation: 0 }, error: null }, // parent
    ],
    optimization_rollouts: [{ data: [], error: null }], // empty minibatch feedback
  };
  cursors = {
    optimization_runs: 0,
    optimization_candidates: 0,
    optimization_rollouts: 0,
  };
}

const INPUT = {
  optRunId: "opt_1",
  parentCandidateId: "cand_parent",
  targetModule: "system",
  iteration: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  seedQueues();
});

describe("optimization BYO key rejected at runtime (#350-followup)", () => {
  it("logs provider_key.byo_failed and rethrows when a BYO reflect key is rejected", async () => {
    vi.mocked(resolveProviderKey).mockResolvedValue({
      source: "byo",
      key: "sk-customer-byo",
    });
    vi.mocked(createProviderForModel).mockReturnValue({
      propose: vi
        .fn()
        .mockRejectedValue(
          new ProviderHttpError(
            "anthropic",
            401,
            '{"error":{"message":"invalid x-api-key"}}',
          ),
        ),
    } as unknown as ReturnType<typeof createProviderForModel>);

    await expect(proposeCandidate(INPUT)).rejects.toThrow();

    expect(log.warn).toHaveBeenCalledWith(
      "Customer BYO provider key was rejected by the provider",
      expect.objectContaining({
        event: "provider_key.byo_failed",
        provider: "anthropic",
        org_id: "org_free",
        opt_run_id: "opt_1",
        status: 401,
      }),
    );
    // Never logs key material.
    const call = vi
      .mocked(log.warn)
      .mock.calls.find(
        (c) =>
          (c[1] as { event?: string })?.event === "provider_key.byo_failed",
      )!;
    expect(JSON.stringify(call[1])).not.toContain("sk-customer-byo");
  });

  it("does NOT log provider_key.byo_failed when a managed reflect key is rejected", async () => {
    vi.mocked(resolveProviderKey).mockResolvedValue({
      source: "managed",
      key: "managed-key",
    });
    vi.mocked(createManagedMeter).mockResolvedValue({
      assertPriced: vi.fn(),
      record: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof createManagedMeter>>);
    vi.mocked(createProviderForModel).mockReturnValue({
      propose: vi
        .fn()
        .mockRejectedValue(
          new ProviderHttpError(
            "anthropic",
            401,
            '{"error":{"message":"invalid x-api-key"}}',
          ),
        ),
    } as unknown as ReturnType<typeof createProviderForModel>);

    await expect(proposeCandidate(INPUT)).rejects.toThrow();

    const byoLogged = vi
      .mocked(log.warn)
      .mock.calls.some(
        (c) =>
          (c[1] as { event?: string })?.event === "provider_key.byo_failed",
      );
    expect(byoLogged).toBe(false);
  });

  it("does NOT log provider_key.byo_failed for a non-provider error on a BYO run", async () => {
    vi.mocked(resolveProviderKey).mockResolvedValue({
      source: "byo",
      key: "sk-customer-byo",
    });
    vi.mocked(createProviderForModel).mockReturnValue({
      propose: vi
        .fn()
        .mockRejectedValue(
          new Error("Reflection model returned an empty prompt"),
        ),
    } as unknown as ReturnType<typeof createProviderForModel>);

    await expect(proposeCandidate(INPUT)).rejects.toThrow();

    const byoLogged = vi
      .mocked(log.warn)
      .mock.calls.some(
        (c) =>
          (c[1] as { event?: string })?.event === "provider_key.byo_failed",
      );
    expect(byoLogged).toBe(false);
  });
});
