import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateRun } from "./evaluator.js";
import { sendFailureEmail } from "./emailer.js";
import {
  resolveProviderKey,
  resolveEvalJudge,
} from "./providers/resolve-key.js";
import { createManagedMeter } from "./providers/managed-meter.js";
import { ProviderHttpError } from "./providers/http.js";

// Customer BYO key rejected at runtime (Requirement 1 + 2): when a run's provider call fails and
// the key in use was the Team's own (source === "byo"), the worker emits a distinct
// `provider_key.byo_failed` log so the failure is attributable to the customer's key — and the run
// simply fails. There is NO path that retries a rejected BYO key on the managed platform key
// (Requirement 2): the rejection propagates to the run error path and the run is marked failed.

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));
vi.mock("http", () => ({ createServer: () => ({ listen: vi.fn() }) }));

// Constructable provider stub — the worker does `new AnthropicProvider(...)` per run.
vi.mock("./providers/anthropic.js", () => ({
  AnthropicProvider: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

// Per-run key resolution is unit-tested in resolve-key.test.ts; here it is stubbed so each test
// chooses the source (byo vs managed) that drives the catch-path branch under test.
vi.mock("./providers/resolve-key.js", () => ({
  resolveProviderKey: vi.fn(),
  resolveEvalJudge: vi.fn(),
  MISSING_PROVIDER_KEY_MESSAGE: "no key",
}));

// The managed-meter build (for the managed-source case) is stubbed to a no-op meter so the managed
// path reaches evaluateRun without touching real billing tables; metering itself is covered
// elsewhere. UnpricedManagedCallError is preserved from the real module (worker.ts re-throws it).
vi.mock("./providers/managed-meter.js", async (importActual) => {
  const actual =
    await importActual<typeof import("./providers/managed-meter.js")>();
  return { ...actual, createManagedMeter: vi.fn() };
});

vi.mock("./evaluator.js", () => ({ evaluateRun: vi.fn() }));
vi.mock("./emailer.js", () => ({
  sendCompletionEmail: vi.fn(),
  sendFailureEmail: vi.fn(),
}));
vi.mock("./telemetry.js", () => ({
  initTelemetry: vi.fn(),
  trackRunCompleted: vi.fn(),
  captureException: vi.fn(),
}));

const ORG = "org_free";

// A manual eval run (no schedule): the maybeSingle reads resolve run → rubric → claim, then the
// rows load via .order(). evaluateRun then throws to drive the catch path.
function queueManualRun(
  runId: string,
): Record<string, ReturnType<typeof vi.fn>> {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    maybeSingle: vi.fn(),
  };
  for (const k of ["select", "eq", "order", "update", "insert"])
    chain[k].mockReturnValue(chain);
  chain.maybeSingle
    .mockResolvedValueOnce({
      data: {
        id: runId,
        rubric_id: "rubric_1",
        notification_emails: [],
        eval_type: "tabular",
        schedule_id: null,
      },
      error: null,
    })
    .mockResolvedValueOnce({
      data: {
        org_id: ORG,
        name: "R",
        scenario_description: "s",
        expected_outcome: "o",
        grounding_context: null,
        criteria: [{ name: "Accuracy", weight: 1, steps: ["x"] }],
      },
      error: null,
    })
    .mockResolvedValueOnce({ data: { id: runId }, error: null });
  chain.order.mockResolvedValueOnce({
    data: [
      {
        row_index: 0,
        user_input: "hi",
        agent_output: "yo",
        expected_output: null,
        retrieval_context: null,
      },
    ],
    error: null,
  });
  mockFrom.mockReturnValue(chain);
  mockRpc.mockImplementation((fn: string) =>
    fn === "dequeue_eval_run_message"
      ? Promise.resolve({ data: [{ msg_id: 1n, run_id: runId }], error: null })
      : Promise.resolve({ data: null, error: null }),
  );
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendFailureEmail).mockResolvedValue(undefined);
  vi.mocked(createManagedMeter).mockResolvedValue({
    record: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof createManagedMeter>>);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("BYO key rejected at runtime (#350-followup)", () => {
  it("logs provider_key.byo_failed and fails the run when a BYO judge key is rejected", async () => {
    // A Free Team running on its own (BYO) Anthropic key.
    vi.mocked(resolveEvalJudge).mockResolvedValue({
      provider: "anthropic",
      judgeModel: "claude-haiku-4-5-20251001",
      resolved: { source: "byo", key: "sk-customer-byo" },
    });
    const chain = queueManualRun("run_byo_fail");
    // The provider rejects the customer's key at call time (401 invalid key).
    vi.mocked(evaluateRun).mockRejectedValue(
      new ProviderHttpError(
        "anthropic",
        401,
        '{"error":{"message":"invalid x-api-key"}}',
      ),
    );

    const { poll } = await import("./worker.js");
    await poll();

    // The distinct BYO-failure event fires, attributed to the customer's key + org + HTTP status.
    // It must never carry the key material itself.
    expect(console.warn).toHaveBeenCalledWith(
      "Customer BYO provider key was rejected by the provider",
      expect.objectContaining({
        event: "provider_key.byo_failed",
        provider: "anthropic",
        org_id: ORG,
        status: 401,
      }),
    );
    const [, attrs] = (
      console.warn as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.find(
      (c) => (c[1] as { event?: string })?.event === "provider_key.byo_failed",
    )!;
    expect(JSON.stringify(attrs)).not.toContain("sk-customer-byo");

    // The run fails — it is NOT retried on a managed key. resolution happened exactly once.
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
    expect(chain.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect(resolveEvalJudge).toHaveBeenCalledTimes(1);
    expect(resolveProviderKey).not.toHaveBeenCalled();
  });

  it("does NOT log provider_key.byo_failed when a managed key is rejected (generic failure only)", async () => {
    // A paid Team falling back to the managed platform key.
    vi.mocked(resolveEvalJudge).mockResolvedValue({
      provider: "anthropic",
      judgeModel: "claude-haiku-4-5-20251001",
      resolved: { source: "managed", key: "managed-platform-key" },
    });
    const chain = queueManualRun("run_managed_fail");
    vi.mocked(evaluateRun).mockRejectedValue(
      new ProviderHttpError(
        "anthropic",
        401,
        '{"error":{"message":"invalid x-api-key"}}',
      ),
    );

    const { poll } = await import("./worker.js");
    await poll();

    // A managed-key failure stays the generic provider error — the BYO event must NOT fire.
    const byoLogged = (
      console.warn as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.some(
      (c) => (c[1] as { event?: string })?.event === "provider_key.byo_failed",
    );
    expect(byoLogged).toBe(false);
    // The run still fails (no silent success).
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("does NOT log provider_key.byo_failed for a non-provider error on a BYO run", async () => {
    // Same BYO setup, but the failure is a DB/logic error — it does not implicate the key.
    vi.mocked(resolveEvalJudge).mockResolvedValue({
      provider: "anthropic",
      judgeModel: "claude-haiku-4-5-20251001",
      resolved: { source: "byo", key: "sk-customer-byo" },
    });
    queueManualRun("run_db_fail");
    vi.mocked(evaluateRun).mockRejectedValue(
      new Error("Failed to save results: timeout"),
    );

    const { poll } = await import("./worker.js");
    await poll();

    const byoLogged = (
      console.warn as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.some(
      (c) => (c[1] as { event?: string })?.event === "provider_key.byo_failed",
    );
    expect(byoLogged).toBe(false);
  });
});
