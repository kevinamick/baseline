// Ambient log correlation for Temporal Activities (issue #38 follow-up).
//
// Both optimization runs and eval runs now execute as Temporal Activities (ADR-0006), outside
// any per-message scope, so their deep call sites (provider clients, the evaluator) would fire
// with no ambient run identity. This Activity-inbound interceptor closes that gap with zero
// call-site threading: it reads the run id out of the Activity's input and runs the whole
// Activity inside a `runWithLogContext` scope, so those deep call sites auto-stamp their run's
// id onto every OTel record (see ../log-context.ts):
//   - optimization Activities carry `optRunId` → stamped as `opt_run_id`;
//   - eval-run Activities carry `evalRunId` (prepareEvalRun takes the bare id string) → stamped
//     as `run_id`, the mirror of the old worker.ts `processMessage` scope.
// `org_id` isn't in the Activity args (only the run/rubric load knows it), so it's patched in
// there via `setLogContext`. `run_id` and `opt_run_id` are distinct id namespaces.
//
// Registered on the Temporal Worker in ./worker.ts via `interceptors.activity`.

import type { Context as ActivityContext } from "@temporalio/activity";
import type {
  ActivityInterceptors,
  ActivityExecuteInput,
  Next,
  ActivityInboundCallsInterceptor,
} from "@temporalio/worker";
import { runWithLogContext, type LogContext } from "../log-context.js";

// Pull the run scope out of an Activity's arguments. Optimization Activities carry `optRunId`
// (all but `seedRun`, which takes the bare id string); eval-run Activities carry `evalRunId`
// (all but `prepareEvalRun`, which takes the bare id string). `ping` (the tracer-bullet
// Activity) takes an unrelated string, so a bare string is only treated as a run id for the two
// activities known to pass one — anything else yields undefined and the Activity runs unscoped.
function runScopeFromArgs(
  activityType: string,
  args: readonly unknown[],
): LogContext | undefined {
  const first = args[0];
  if (first && typeof first === "object") {
    if ("optRunId" in first && typeof (first as { optRunId?: unknown }).optRunId === "string") {
      return { opt_run_id: (first as { optRunId: string }).optRunId };
    }
    if ("evalRunId" in first && typeof (first as { evalRunId?: unknown }).evalRunId === "string") {
      return { run_id: (first as { evalRunId: string }).evalRunId };
    }
    return undefined;
  }
  if (typeof first === "string") {
    if (activityType === "seedRun") return { opt_run_id: first };
    if (activityType === "prepareEvalRun") return { run_id: first };
  }
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
      const scope = runScopeFromArgs(ctx.info.activityType, input.args);
      if (!scope) return next(input);
      return runWithLogContext(scope, () => next(input));
    },
  };
  return { inbound };
}
