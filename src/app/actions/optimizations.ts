"use server";

import { randomUUID } from "node:crypto";
import { getAuthContext } from "@/lib/auth/context";
import { getTemporalClient } from "@/lib/temporal/client";
import { OPTIMIZATION_TASK_QUEUE } from "@/lib/temporal/connection";

// Tracer-bullet entry point for the Temporal foundation (issue #85). Starts the trivial
// pingWorkflow and returns its id so it can be observed in the Temporal Web UI. The real
// startOptimizationRun() server action lands once the schema + GEPA workflow exist (#87+).
//
// The workflow is referenced by string name, never imported — workflow code must not enter
// the Next bundle (it runs only inside the Temporal worker's sandbox).
export async function startPing(
  message: string
): Promise<{ workflowId: string } | { error: string }> {
  const { userId } = await getAuthContext();
  if (!userId) return { error: "Not authenticated" };

  const client = await getTemporalClient();
  const workflowId = `ping-${randomUUID()}`;
  await client.workflow.start("pingWorkflow", {
    taskQueue: OPTIMIZATION_TASK_QUEUE,
    workflowId,
    args: [{ message }],
  });

  return { workflowId };
}
