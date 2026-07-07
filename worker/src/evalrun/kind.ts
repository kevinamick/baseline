// Eval-run input kinds and prepare outcomes, single-sourced (one const list -> derived
// type) per the enum convention. Pure constants only: this module is imported by both the
// Workflow (Temporal's deterministic sandbox) and the Activities, so it must stay free of
// side effects and Node-only imports.
//
// Kinds mirror how a run's rows come to exist:
//   - manual:  the create form supplied complete rows (agent_output already present).
//   - agent:   a Schedule copied fixed inputs with empty agent_output — the run invokes
//              the agent Connection live to fill them before judging.
//   - dataset: no rows exist at start — the run reads complete rows from the dataset
//              Connection's source over the Schedule's window.

export const MANUAL_KIND = "manual";
export const AGENT_KIND = "agent";
export const DATASET_KIND = "dataset";

export const EVAL_RUN_INPUT_KINDS = [MANUAL_KIND, AGENT_KIND, DATASET_KIND] as const;
export type EvalRunInputKind = (typeof EVAL_RUN_INPUT_KINDS)[number];

// prepareEvalRun's outcome: READY means rows exist and the run should be scored; SKIPPED
// means a dataset window yielded no usable rows — terminal, neither success nor failure
// (mirrors the pgmq path's 'skipped' status: no email, excluded from trends).
export const READY = "ready";
export const SKIPPED = "skipped";

export const PREPARE_OUTCOMES = [READY, SKIPPED] as const;
export type PrepareOutcome = (typeof PREPARE_OUTCOMES)[number];
