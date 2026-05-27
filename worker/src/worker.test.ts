import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// --- Mocks ---

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));

vi.mock("http", () => ({
  createServer: () => ({ listen: vi.fn() }),
}));

vi.mock("./providers/anthropic.js", () => ({
  AnthropicProvider: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("./evaluator.js", () => ({ evaluateRun: vi.fn() }));
vi.mock("./emailer.js", () => ({ sendCompletionEmail: vi.fn(), sendFailureEmail: vi.fn() }));
vi.mock("./telemetry.js", () => ({
  initTelemetry: vi.fn(),
  trackRunCompleted: vi.fn(),
  captureException: vi.fn(),
}));

// --- Setup ---

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// --- reapStaleRuns ---

describe("reapStaleRuns", () => {
  it("calls reap_stale_eval_runs RPC with the configured threshold", async () => {
    mockRpc.mockResolvedValue({ data: 0, error: null });
    const { reapStaleRuns } = await import("./worker.js");
    await reapStaleRuns();
    expect(mockRpc).toHaveBeenCalledWith("reap_stale_eval_runs", {
      p_threshold_minutes: 10,
    });
  });

  it("logs the count when runs are reaped", async () => {
    mockRpc.mockResolvedValue({ data: 3, error: null });
    const { reapStaleRuns } = await import("./worker.js");
    await reapStaleRuns();
    expect(console.log).toHaveBeenCalledWith("Reaped 3 stale run(s)");
  });

  it("does not log when no runs are reaped", async () => {
    mockRpc.mockResolvedValue({ data: 0, error: null });
    const { reapStaleRuns } = await import("./worker.js");
    await reapStaleRuns();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("logs error and does not throw when RPC fails", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "db error" } });
    const { reapStaleRuns } = await import("./worker.js");
    await expect(reapStaleRuns()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "Stale run reaper error",
      expect.objectContaining({ message: "db error" })
    );
  });
});

// --- poll ---

describe("poll", () => {
  function makeFromChain(result: unknown) {
    const chain = { select: vi.fn(), eq: vi.fn(), order: vi.fn(), update: vi.fn(), maybeSingle: vi.fn() };
    for (const k of ["select", "eq", "order", "update"] as const) chain[k].mockReturnValue(chain);
    chain.maybeSingle.mockResolvedValue(result);
    mockFrom.mockReturnValue(chain);
    return chain;
  }

  it("returns false when queue is empty", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const { poll } = await import("./worker.js");
    expect(await poll({} as never)).toBe(false);
  });

  it("returns false on dequeue RPC error", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "queue error" } });
    const { poll } = await import("./worker.js");
    expect(await poll({} as never)).toBe(false);
  });

  it("returns true when a message is dequeued and processed", async () => {
    // First rpc call = dequeue, subsequent calls = ack
    mockRpc
      .mockResolvedValueOnce({ data: [{ msg_id: BigInt(1), run_id: "run_abc" }], error: null })
      .mockResolvedValue({ error: null });

    // processMessage fetches run → null so it acks and returns early
    makeFromChain({ data: null, error: { message: "not found" } });

    const { poll } = await import("./worker.js");
    expect(await poll({} as never)).toBe(true);
  });
});
