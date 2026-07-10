-- Optimization Runs: termination reason (#469).
--
-- A run that completes without ever entering iteration 1 currently looks identical to a
-- successful optimization run: status completed, best candidate set (to the seed), no error,
-- no explanation. Prod incident: run opt-4afa3642 completed this way after its baseline (seed)
-- evaluation alone exhausted the run's rollout budget — the only symptom was the full budget
-- spent with a lift of zero.
--
-- termination_reason is a nullable REASON CODE (never prose — the app/worker translate the code
-- to copy per locale, mirrors the `mode` column's CHECK-constrained code convention above), set
-- only by the completeRun terminal Activity (worker/src/gepa/activities.ts) when the workflow's
-- pure deriveTerminationReason (worker/src/gepa/termination-reason.ts) finds the loop was never
-- entered. Null for every normal completion (at least one iteration/round ran) and for every
-- non-completed run (queued/running/paused/failed use error_message/paused_reason instead).

alter table "public"."optimization_runs"
  add column if not exists "termination_reason" "text";

alter table "public"."optimization_runs"
  add constraint "optimization_runs_termination_reason_check"
  check (
    "termination_reason" is null
    or "termination_reason" = any (array[
      'budget_exhausted_by_baseline',
      'no_modules',
      'no_instances'
    ])
  );

comment on column "public"."optimization_runs"."termination_reason" is
  'Reason code (#469) set only when the run completed without ever entering iteration 1 — the '
  'single source of the code list is worker/src/gepa/termination-reason.ts (TERMINATION_REASONS). '
  'Null for every normal completion and every non-completed run.';
