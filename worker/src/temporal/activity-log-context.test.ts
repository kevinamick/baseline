import { describe, it, expect } from "vitest";
import type { Context as ActivityContext } from "@temporalio/activity";
import type { ActivityExecuteInput } from "@temporalio/worker";
import { activityLogContextInterceptors } from "./activity-log-context.js";
import { currentLogContext } from "../log-context.js";

// Build the minimal ActivityContext the interceptor reads (only info.activityType).
function ctxFor(activityType: string): ActivityContext {
  return { info: { activityType } } as unknown as ActivityContext;
}

// Run the interceptor's execute() with the given args, capturing the ambient log context
// observed *inside* the wrapped Activity (what a deep call-site log would see).
async function observeContext(
  activityType: string,
  args: unknown[],
): Promise<ReturnType<typeof currentLogContext>> {
  const { inbound } = activityLogContextInterceptors(ctxFor(activityType));
  const input = { args, headers: {} } as ActivityExecuteInput;
  let seen: ReturnType<typeof currentLogContext>;
  await inbound!.execute!(input, async () => {
    seen = currentLogContext();
    return "ok";
  });
  return seen;
}

describe("activityLogContextInterceptors", () => {
  it("opens a scope carrying opt_run_id from an input object's optRunId", async () => {
    const seen = await observeContext("rolloutCandidate", [
      { optRunId: "opt_1", candidateId: "c_1", phase: "pareto" },
    ]);
    expect(seen).toEqual({ opt_run_id: "opt_1" });
  });

  it("treats a bare string arg as the opt_run_id for seedRun", async () => {
    const seen = await observeContext("seedRun", ["opt_seed"]);
    expect(seen).toEqual({ opt_run_id: "opt_seed" });
  });

  it("does not treat a string arg as a run id for other activities (e.g. ping)", async () => {
    const seen = await observeContext("ping", ["hello"]);
    expect(seen).toBeUndefined();
  });

  it("opens no scope when no optRunId can be resolved", async () => {
    const seen = await observeContext("rolloutCandidate", [{ candidateId: "c" }]);
    expect(seen).toBeUndefined();
  });

  it("returns the wrapped activity's result unchanged", async () => {
    const { inbound } = activityLogContextInterceptors(ctxFor("seedRun"));
    const input = { args: ["opt_x"], headers: {} } as ActivityExecuteInput;
    const result = await inbound!.execute!(input, async () => "the-result");
    expect(result).toBe("the-result");
  });
});
