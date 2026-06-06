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
// result. The GepaWorkflow loop replaces this as the real workload in later slices.
export async function pingWorkflow(input: PingInput): Promise<string> {
  return ping(input.message);
}
