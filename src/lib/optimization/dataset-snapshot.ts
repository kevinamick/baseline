import "server-only";
// One-time snapshot of a dataset Connection's rows into an Optimization Run's frozen Instance
// set (#82) — the fourth intake source alongside the wizard's manual/CSV/JSON rows. Reuses the
// exact seam the "Test query" preview (#39) and the schedule/eval worker use — fetchDatasetRows
// → getDatasetAdapter — so the SSRF egress guard + PostHog host allowlist apply identically and
// no fetch logic is duplicated here. See AGENTS.md "Dataset Connections".
//
// This module is a pure resolver: given an already org-scoped Connection (the caller — the
// optimization-run action — looks it up via tenantDb and decrypts its credential) and a window,
// it returns the mapped, capped instance rows or a categorized fetch failure. It does not touch
// the database itself, so it stays trivially testable and reusable.
import {
  fetchDatasetRows,
  type DatasetFetchDeps,
} from "@/lib/connections/dataset-fetch";
import type { PreviewErrorCode } from "@/lib/connections/preview-types";
import { MAX_OPTIMIZATION_INSTANCES } from "@/lib/validation/schemas";
import type { DatasetConnection, FetchContext } from "../../../worker/src/adapters";

// How long the snapshot waits for the adapter before giving up. Longer than the "Test query"
// preview's PREVIEW_TIMEOUT_MS (15s): the preview asks for a handful of sample rows, this asks
// for up to MAX_OPTIMIZATION_INSTANCES over a window that can span up to 30 days — a bigger,
// one-time query run at Optimization Run creation, not while a user watches a dialog spinner.
export const DATASET_SNAPSHOT_TIMEOUT_MS = 30_000;

// An Instance has no agent_output — it's a frozen INPUT the run scores a newly-generated
// Candidate's output against, never a historical output — so the adapter's agent_output column
// is dropped on the way in.
export interface ResolvedOptimizationInstance {
  userInput: string;
  expectedOutput: string | null;
  retrievalContext: string | null;
}

export type DatasetSnapshotResult =
  | { instances: ResolvedOptimizationInstance[] }
  | { error: PreviewErrorCode; detail?: string };

export interface DatasetSnapshotDeps extends Partial<DatasetFetchDeps> {
  now?: () => Date;
}

// Snapshot a dataset Connection's rows over a lookback window into the Instance shape, capped at
// MAX_OPTIMIZATION_INSTANCES. The adapter is asked for exactly that many rows — the same
// "recent rows in this window, capped at N" contract a Schedule's periodic pull already relies
// on (worker/src/evalrun/activities.ts's resolveDatasetRows) — and the result is defensively
// re-capped in case a source ignores the pushed-down limit. A row with no usable user_input is
// skipped, mirroring the worker's own eval-row filter. An empty result (no error, zero rows) is
// NOT itself an error here — same convention as runDatasetPreview — the caller decides how to
// refuse an empty window.
export async function snapshotDatasetInstances(
  connection: DatasetConnection,
  authValue: string | null,
  windowMinutes: number,
  deps: DatasetSnapshotDeps = {}
): Promise<DatasetSnapshotResult> {
  const now = deps.now ?? (() => new Date());
  const end = now();
  const start = new Date(end.getTime() - windowMinutes * 60_000);
  const ctx: FetchContext = {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    maxRows: MAX_OPTIMIZATION_INSTANCES,
    authValue,
  };

  const fetched = await fetchDatasetRows(connection, ctx, {
    adapter: deps.adapter,
    timeoutMs: deps.timeoutMs ?? DATASET_SNAPSHOT_TIMEOUT_MS,
  });
  if ("error" in fetched) return fetched;

  const instances = fetched.rows
    .filter((r) => r.user_input?.trim())
    .slice(0, MAX_OPTIMIZATION_INSTANCES)
    .map((r) => ({
      userInput: r.user_input,
      expectedOutput: r.expected_output,
      retrievalContext: r.retrieval_context,
    }));

  return { instances };
}
