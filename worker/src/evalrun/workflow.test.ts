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
    });
    await runEvalWorkflow({ evalRunId: RUN_ID });

    expect(acts.invokeAgentRow).not.toHaveBeenCalled();
    expect(acts.judgeEvalRun).toHaveBeenCalledWith({ evalRunId: RUN_ID });
    expect(acts.completeEvalRun).toHaveBeenCalled();
  });

  it("agent run: fans out one invocation per input row before judging", async () => {
    const rowIndexes = [0, 1, 2, 3, 4, 5, 6]; // more rows than the concurrency cap
    acts.prepareEvalRun.mockResolvedValue({ outcome: READY, kind: AGENT_KIND, rowIndexes });
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
    acts.prepareEvalRun.mockResolvedValue({ outcome: READY, kind: AGENT_KIND, rowIndexes: [0] });

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
});
