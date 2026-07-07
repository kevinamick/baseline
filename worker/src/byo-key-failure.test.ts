import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateRun } from "./evaluator.js";
import { resolveEvalJudge } from "./providers/resolve-key.js";
import { createManagedMeter } from "./providers/managed-meter.js";
import { ProviderHttpError } from "./providers/http.js";

// Customer BYO key rejected at runtime (#350-followup), now on the Temporal judge Activity:
// when the judge provider call fails and the key in use was the Team's own (source === "byo"),
// the worker emits a distinct `provider_key.byo_failed` log so the failure is attributable to
// the customer's key — and the run fails. There is NO path that retries a rejected BYO key on
// the managed platform key: resolution happens exactly once. (worker/CLAUDE.md invariant.)

// The Activities read/write Postgres through one supabase client; an ordered results queue
// drives each read in execution order.
const db = vi.hoisted(() => ({
  results: [] as unknown[],
  rpc: vi.fn(),
  next(): unknown {
    return db.results.length > 0 ? db.results.shift() : { data: null, error: null, count: null };
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "insert", "update", "upsert", "delete", "eq", "in", "order", "limit", "range"]) {
        builder[m] = () => builder;
      }
      builder.maybeSingle = () => Promise.resolve(db.next());
      builder.single = () => Promise.resolve(db.next());
      builder.then = (resolve: (v: unknown) => void) => resolve(db.next());
      return builder;
    },
    rpc: db.rpc,
  }),
}));

vi.mock("./providers/factory.js", () => ({ createProviderForModel: () => ({ judge: vi.fn() }) }));
vi.mock("./providers/resolve-key.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providers/resolve-key.js")>()),
  resolveEvalJudge: vi.fn(),
  resolveProviderKey: vi.fn(),
}));
vi.mock("./providers/managed-meter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providers/managed-meter.js")>()),
  createManagedMeter: vi.fn(),
}));
vi.mock("./evaluator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./evaluator.js")>()),
  evaluateRun: vi.fn(),
}));
vi.mock("./agent.js", () => ({ invokeAgent: vi.fn(), invokeManagedAgent: vi.fn() }));
vi.mock("./emailer.js", () => ({ sendCompletionEmail: vi.fn(), sendFailureEmail: vi.fn() }));
vi.mock("./telemetry.js", () => ({
  initTelemetry: vi.fn(),
  trackRunCompleted: vi.fn(),
  captureException: vi.fn(),
}));

const ORG = "org_free";
const RUN_ID = "run-byo";

// judgeEvalRun reads: run → org → rubric → rows → existing results. Then resolveEvalJudge (mock)
// and evaluateRun (mock) drive the catch path.
function queueJudge() {
  db.results = [
    { data: { id: RUN_ID, rubric_id: "rubric-1", schedule_id: null, eval_type: "tabular" }, error: null },
    { data: { org_id: ORG }, error: null },
    {
      data: {
        name: "R",
        scenario_description: "s",
        expected_outcome: "o",
        grounding_context: null,
        criteria: [{ name: "Accuracy", weight: 1, steps: ["x"] }],
      },
      error: null,
    },
    { data: [{ row_index: 0, user_input: "hi", agent_output: "yo", expected_output: null, retrieval_context: null }], error: null },
    { data: [], error: null }, // no prior results
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  db.rpc.mockResolvedValue({ data: null, error: null });
  vi.mocked(createManagedMeter).mockResolvedValue({ record: vi.fn() } as unknown as Awaited<
    ReturnType<typeof createManagedMeter>
  >);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("BYO key rejected at runtime (#350-followup)", () => {
  it("logs provider_key.byo_failed and fails when a BYO judge key is rejected", async () => {
    vi.mocked(resolveEvalJudge).mockResolvedValue({
      provider: "anthropic",
      judgeModel: "claude-haiku-4-5-20251001",
      resolved: { source: "byo", key: "sk-customer-byo" },
    });
    queueJudge();
    vi.mocked(evaluateRun).mockRejectedValue(
      new ProviderHttpError("anthropic", 401, '{"error":{"message":"invalid x-api-key"}}')
    );

    const { judgeEvalRun } = await import("./evalrun/activities.js");
    await expect(judgeEvalRun({ evalRunId: RUN_ID })).rejects.toThrow();

    // The distinct BYO-failure event fires, attributed to the customer's key + org + HTTP status,
    // and never carries the key material.
    expect(console.warn).toHaveBeenCalledWith(
      "Customer BYO provider key was rejected by the provider",
      expect.objectContaining({
        event: "provider_key.byo_failed",
        provider: "anthropic",
        org_id: ORG,
        status: 401,
      })
    );
    const [, attrs] = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(
      (c) => (c[1] as { event?: string })?.event === "provider_key.byo_failed"
    )!;
    expect(JSON.stringify(attrs)).not.toContain("sk-customer-byo");
  });

  it("does NOT log provider_key.byo_failed when a managed key is rejected", async () => {
    vi.mocked(resolveEvalJudge).mockResolvedValue({
      provider: "anthropic",
      judgeModel: "claude-haiku-4-5-20251001",
      resolved: { source: "managed", key: "managed-platform-key" },
    });
    queueJudge();
    vi.mocked(evaluateRun).mockRejectedValue(
      new ProviderHttpError("anthropic", 401, '{"error":{"message":"invalid x-api-key"}}')
    );

    const { judgeEvalRun } = await import("./evalrun/activities.js");
    await expect(judgeEvalRun({ evalRunId: RUN_ID })).rejects.toThrow();

    const byoLogged = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
      (c) => (c[1] as { event?: string })?.event === "provider_key.byo_failed"
    );
    expect(byoLogged).toBe(false);
  });

  it("does NOT log provider_key.byo_failed for a non-provider error on a BYO run", async () => {
    vi.mocked(resolveEvalJudge).mockResolvedValue({
      provider: "anthropic",
      judgeModel: "claude-haiku-4-5-20251001",
      resolved: { source: "byo", key: "sk-customer-byo" },
    });
    queueJudge();
    vi.mocked(evaluateRun).mockRejectedValue(new Error("Failed to save results: timeout"));

    const { judgeEvalRun } = await import("./evalrun/activities.js");
    await expect(judgeEvalRun({ evalRunId: RUN_ID })).rejects.toThrow();

    const byoLogged = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
      (c) => (c[1] as { event?: string })?.event === "provider_key.byo_failed"
    );
    expect(byoLogged).toBe(false);
  });
});
