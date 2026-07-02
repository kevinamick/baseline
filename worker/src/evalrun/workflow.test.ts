import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApplicationFailure } from "@temporalio/common";

// --- Mocks ---
// The workflow's only collaborators are its Activity proxies. Mocking @temporalio/workflow
// so proxyActivities hands back our fakes lets the orchestration run as a plain async
// function: prepare → (agent fan-out) → judge → complete, and the failure path.

const acts = vi.hoisted(() => ({
  prepareEvalRun: vi.fn(),
  invokeAgentRow: vi.fn(),
  judgeEvalRun: vi.fn(),
  completeEvalRun: vi.fn(),
  failEvalRun: vi.fn(),
}));

vi.mock("@temporalio/workflow", async () => {
  const { ApplicationFailure } = await import("@temporalio/common");
  return {
    proxyActivities: () => acts,
    ApplicationFailure,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

import { runEvalWorkflow } from "./workflow.js";
import { AGENT_KIND, DATASET_KIND, MANUAL_KIND, READY, SKIPPED } from "./kind.js";

const RUN_ID = "run-1";

beforeEach(() => {
  vi.clearAllMocks();
  acts.prepareEvalRun.mockResolvedValue({
    outcome: READY,
    kind: MANUAL_KIND,
    rowIndexes: [0, 1],
    agentFanoutConcurrency: 5,
  });
  acts.invokeAgentRow.mockResolvedValue(undefined);
  acts.judgeEvalRun.mockResolvedValue({ overallScore: 0.875, rowCount: 2 });
  acts.completeEvalRun.mockResolvedValue(undefined);
  acts.failEvalRun.mockResolvedValue(undefined);
});

describe("runEvalWorkflow", () => {
  it("manual run: judges and completes without invoking the agent", async () => {
    await runEvalWorkflow({ evalRunId: RUN_ID });

    expect(acts.prepareEvalRun).toHaveBeenCalledWith(RUN_ID);
    expect(acts.invokeAgentRow).not.toHaveBeenCalled();
    expect(acts.judgeEvalRun).toHaveBeenCalledWith({ evalRunId: RUN_ID });
    expect(acts.completeEvalRun).toHaveBeenCalledWith({
      evalRunId: RUN_ID,
      overallScore: 0.875,
      rowCount: 2,
    });
    expect(acts.failEvalRun).not.toHaveBeenCalled();
  });

  it("dataset run: rows arrive complete, so it goes straight to judging", async () => {
    acts.prepareEvalRun.mockResolvedValue({
      outcome: READY,
      kind: DATASET_KIND,
      rowIndexes: [0, 1, 2],
      agentFanoutConcurrency: 5,
    });
    await runEvalWorkflow({ evalRunId: RUN_ID });

    expect(acts.invokeAgentRow).not.toHaveBeenCalled();
    expect(acts.judgeEvalRun).toHaveBeenCalledWith({ evalRunId: RUN_ID });
    expect(acts.completeEvalRun).toHaveBeenCalled();
  });

  it("agent run: fans out one invocation per input row before judging", async () => {
    const rowIndexes = [0, 1, 2, 3, 4, 5, 6]; // more rows than the concurrency cap
    acts.prepareEvalRun.mockResolvedValue({ outcome: READY, kind: AGENT_KIND, rowIndexes, agentFanoutConcurrency: 5 });
    const order: string[] = [];
    acts.invokeAgentRow.mockImplementation(async () => {
      order.push("invoke");
    });
    acts.judgeEvalRun.mockImplementation(async () => {
      order.push("judge");
      return { overallScore: 0.5, rowCount: rowIndexes.length };
    });

    await runEvalWorkflow({ evalRunId: RUN_ID });

    expect(acts.invokeAgentRow).toHaveBeenCalledTimes(rowIndexes.length);
    for (const rowIndex of rowIndexes) {
      expect(acts.invokeAgentRow).toHaveBeenCalledWith({ evalRunId: RUN_ID, rowIndex });
    }
    // Every invocation settles before the judge runs.
    expect(order).toEqual([...rowIndexes.map(() => "invoke"), "judge"]);
  });

  it("skipped run (quiet dataset window): stops after prepare, no judge/complete/fail", async () => {
    acts.prepareEvalRun.mockResolvedValue({ outcome: SKIPPED });
    await runEvalWorkflow({ evalRunId: RUN_ID });

    expect(acts.invokeAgentRow).not.toHaveBeenCalled();
    expect(acts.judgeEvalRun).not.toHaveBeenCalled();
    expect(acts.completeEvalRun).not.toHaveBeenCalled();
    expect(acts.failEvalRun).not.toHaveBeenCalled();
  });

  it("failure: records the run failed, then throws a nonRetryable ApplicationFailure", async () => {
    acts.judgeEvalRun.mockRejectedValue(new Error("judge blew up"));

    const thrown = await runEvalWorkflow({ evalRunId: RUN_ID }).catch((err) => err);

    expect(acts.failEvalRun).toHaveBeenCalledWith({ evalRunId: RUN_ID, message: "judge blew up" });
    expect(acts.completeEvalRun).not.toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    expect((thrown as ApplicationFailure).message).toBe("judge blew up");
  });

  it("failure reason unwraps to the deepest cause (the actionable Activity error)", async () => {
    // Temporal wraps an Activity's failure in an ActivityFailure whose own message is
    // generic; the workflow must surface the root cause on the run row.
    const wrapped = new Error("Activity task failed", {
      cause: new Error("Agent endpoint https://x.example returned HTTP 500"),
    });
    acts.invokeAgentRow.mockRejectedValue(wrapped);
    acts.prepareEvalRun.mockResolvedValue({ outcome: READY, kind: AGENT_KIND, rowIndexes: [0], agentFanoutConcurrency: 5 });

    await expect(runEvalWorkflow({ evalRunId: RUN_ID })).rejects.toThrow(
      "Agent endpoint https://x.example returned HTTP 500"
    );
    expect(acts.failEvalRun).toHaveBeenCalledWith({
      evalRunId: RUN_ID,
      message: "Agent endpoint https://x.example returned HTTP 500",
    });
  });

  it("failure in prepare itself still records a reason on the run", async () => {
    acts.prepareEvalRun.mockRejectedValue(new Error("No input rows found"));

    await expect(runEvalWorkflow({ evalRunId: RUN_ID })).rejects.toThrow("No input rows found");
    expect(acts.failEvalRun).toHaveBeenCalledWith({
      evalRunId: RUN_ID,
      message: "No input rows found",
    });
  });

  // --- determinism ---
  // The workflow runs inside Temporal's deterministic sandbox: same input + same Activity
  // results must yield the identical Activity call sequence on every replay. It carries no
  // Date.now / Math.random and orchestrates purely from Activity return values, so two runs
  // with identical mocks produce identical histories — the property replay verification relies
  // on. (Codebase convention, per gepa/workflow.guard.test.ts: drive the real workflow with
  // mocked Temporal primitives, no TestWorkflowEnvironment / native test-server binary.)
  it("is deterministic: identical inputs replay to the identical Activity call sequence", async () => {
    const rowIndexes = [0, 1, 2, 3, 4, 5, 6];
    acts.prepareEvalRun.mockResolvedValue({ outcome: READY, kind: AGENT_KIND, rowIndexes, agentFanoutConcurrency: 5 });

    async function record(): Promise<string[]> {
      const seq: string[] = [];
      acts.prepareEvalRun.mockImplementation(async () => {
        seq.push("prepare");
        return { outcome: READY, kind: AGENT_KIND, rowIndexes, agentFanoutConcurrency: 5 };
      });
      acts.invokeAgentRow.mockImplementation(async ({ rowIndex }: { rowIndex: number }) => {
        seq.push(`invoke:${rowIndex}`);
      });
      acts.judgeEvalRun.mockImplementation(async () => {
        seq.push("judge");
        return { overallScore: 0.5, rowCount: rowIndexes.length };
      });
      acts.completeEvalRun.mockImplementation(async () => {
        seq.push("complete");
      });
      await runEvalWorkflow({ evalRunId: RUN_ID });
      return seq;
    }

    const first = await record();
    const second = await record();
    expect(first).toEqual(second);
    // prepare first, complete last, and every row invoked exactly once before the judge.
    expect(first[0]).toBe("prepare");
    expect(first[first.length - 1]).toBe("complete");
    expect(first.filter((s) => s.startsWith("invoke:")).sort()).toEqual(
      rowIndexes.map((i) => `invoke:${i}`).sort()
    );
    expect(first.indexOf("judge")).toBeGreaterThan(first.lastIndexOf("invoke:6"));
  });

  it("agent fan-out never exceeds the in-workflow concurrency cap", async () => {
    const rowIndexes = Array.from({ length: 12 }, (_, i) => i);
    acts.prepareEvalRun.mockResolvedValue({ outcome: READY, kind: AGENT_KIND, rowIndexes, agentFanoutConcurrency: 5 });
    let inFlight = 0;
    let peak = 0;
    acts.invokeAgentRow.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve(); // yield so multiple runners overlap
      inFlight--;
    });

    await runEvalWorkflow({ evalRunId: RUN_ID });

    // AGENT_FANOUT_CONCURRENCY caps concurrent live invocations at 5 (bounds endpoint load).
    expect(peak).toBeLessThanOrEqual(5);
    expect(acts.invokeAgentRow).toHaveBeenCalledTimes(12);
  });
});
