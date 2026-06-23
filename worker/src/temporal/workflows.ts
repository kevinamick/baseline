// Temporal Workflows. This module is bundled and run inside Temporal's deterministic
// sandbox, so it must not import anything with side effects or non-deterministic behavior
// (no DB clients, no Date.now, no random) — all of that lives in Activities, reached via
// proxyActivities. `import type` of the activities module is erased at bundle time, so the
// activity implementations never enter the sandbox.

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities.js";

const { ping } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
});

export interface PingInput {
  message: string;
}

// The trivial tracer-bullet workflow: hand the message to an Activity and return the
// result. The GEPA optimization workflow below is the first real workload.
export async function pingWorkflow(input: PingInput): Promise<string> {
  return ping(input.message);
}

// The GEPA optimization workflow (#87+). Re-exported here so the single bundled workflows
// path picks it up; its implementation (and its own Activity proxy) lives under gepa/.
export { runOptimizationWorkflow } from "../gepa/workflow.js";

// The Simple (Monte Carlo) optimization workflow (#316, ADR-0015). A second workflow type on
// the same task queue, dispatched by the run's mode; its implementation lives under simple/.
export { runSimpleOptimizationWorkflow } from "../simple/workflow.js";
