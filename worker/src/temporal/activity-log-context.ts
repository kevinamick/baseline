// Ambient log correlation for GEPA optimization Activities (issue #38 follow-up).
//
// Eval runs open a log-context scope in worker.ts around processMessage, so their deep call
// sites (provider clients, the evaluator) auto-stamp `run_id`/`org_id` onto every OTel record
// (see ../log-context.ts). Optimization runs take a different path — Temporal Activities,
// outside processMessage — so that scope never covers them: an evaluator/provider log fired
// during a `rolloutCandidate` Activity had no ambient run identity at all.
//
// This Activity-inbound interceptor closes that gap with zero call-site threading: it reads the
// run id out of the Activity's input and runs the whole Activity inside a `runWithLogContext`
// scope, so the same deep call sites correlate to their optimization run. `org_id` isn't in the
// Activity args (only `loadRun` knows it), so it's patched in there via `setLogContext`.
//
// Registered on the Temporal Worker in ./worker.ts via `interceptors.activity`.

import type { Context as ActivityContext } from "@temporalio/activity";
import type {
  ActivityInterceptors,
  ActivityExecuteInput,
  Next,
  ActivityInboundCallsInterceptor,
} from "@temporalio/worker";
import { runWithLogContext } from "../log-context.js";

// Pull the optimization-run id out of an Activity's arguments. Every GEPA Activity but `seedRun`
// takes a single input object carrying `optRunId`; `seedRun` takes the bare id string. `ping` (the
// tracer-bullet Activity) takes an unrelated string, so a string arg is only treated as a run id
// for `seedRun` — anything else yields undefined and the Activity runs with no scope.
function optRunIdFromArgs(
  activityType: string,
  args: readonly unknown[],
): string | undefined {
  const first = args[0];
  if (first && typeof first === "object" && "optRunId" in first) {
    const value = (first as { optRunId?: unknown }).optRunId;
    return typeof value === "string" ? value : undefined;
  }
  if (activityType === "seedRun" && typeof first === "string") return first;
  return undefined;
}

export function activityLogContextInterceptors(
  ctx: ActivityContext,
): ActivityInterceptors {
  const inbound: ActivityInboundCallsInterceptor = {
    execute(
      input: ActivityExecuteInput,
      next: Next<ActivityInboundCallsInterceptor, "execute">,
    ): Promise<unknown> {
      const optRunId = optRunIdFromArgs(ctx.info.activityType, input.args);
      if (!optRunId) return next(input);
      return runWithLogContext({ opt_run_id: optRunId }, () => next(input));
    },
  };
  return { inbound };
}
