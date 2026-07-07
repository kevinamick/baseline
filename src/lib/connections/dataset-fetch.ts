import "server-only";
// The one place either dataset-Connection caller reaches the worker's adapter seam
// (getDatasetAdapter → the custom/posthog adapters) with a timeout leash and categorized error
// classification. Extracted out of preview.ts (#39) so the optimization wizard's dataset-
// Connection snapshot intake (#82) can reuse the exact same resolve-adapter/timeout/classify
// logic instead of duplicating it — see AGENTS.md "Dataset Connections". Each caller still owns
// its own row cap and mapping: the "Test query" preview shows a handful of sample rows for
// verification, the optimization intake resolves a full frozen Instance set.
import {
  getDatasetAdapter,
  type DatasetAdapter,
  type DatasetConnection,
  type DatasetRow,
  type FetchContext,
} from "../../../worker/src/adapters";
import type { PreviewErrorCode } from "./preview-types";

// Thrown when the adapter outlives its caller's leash. The underlying socket is still torn down
// by safeFetch's own absolute deadline; this just bounds what the caller waits on and reports.
export class DatasetFetchTimeoutError extends Error {
  constructor(ms: number) {
    super(`Dataset fetch timed out after ${ms}ms`);
    this.name = "DatasetFetchTimeoutError";
  }
}

// Race the adapter against the caller's leash. Whichever settles first wins; a late adapter
// resolution after a timeout is ignored.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DatasetFetchTimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Map a thrown adapter error to a specific, actionable code. The adapter/safeFetch messages are
// already precise ("PostHog query returned HTTP 401", "Dataset response_path 'x' did not resolve
// to an array", BlockedRequestError reasons); classify them into headline codes and pass the raw
// message through as `detail` for a muted diagnostic line.
export function classifyDatasetFetchError(err: unknown): { error: PreviewErrorCode; detail?: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof DatasetFetchTimeoutError) return { error: "timeout" };
  // Match by name, not instanceof, so it holds even if the class identity differs across a
  // bundled vs. transpiled copy of safe-fetch.
  if (err instanceof Error && err.name === "BlockedRequestError") {
    return { error: "endpoint", detail: message };
  }
  if (/\bHTTP (401|403)\b/.test(message)) return { error: "auth", detail: message };
  if (/did not resolve to an array/.test(message)) return { error: "rows_path", detail: message };
  if (
    /missing project_id or hogql|is not a valid URL|not an allowed PostHog host/.test(message)
  ) {
    return { error: "config", detail: message };
  }
  // A non-JSON response body surfaces as a SyntaxError from res.json().
  if (err instanceof SyntaxError) return { error: "parse", detail: message };
  return { error: "unknown", detail: message };
}

export interface DatasetFetchDeps {
  adapter?: DatasetAdapter;
  timeoutMs: number;
}

// Run the dataset adapter once, within a timeout leash, returning its raw rows or a categorized
// failure. Pure orchestration over the worker adapter seam — it adds no fetch logic of its own,
// and inherits the adapter's SSRF egress guard + PostHog host allowlist (enforced inside
// safeFetch) unconditionally.
export async function fetchDatasetRows(
  connection: DatasetConnection,
  ctx: FetchContext,
  deps: DatasetFetchDeps
): Promise<{ rows: DatasetRow[] } | { error: PreviewErrorCode; detail?: string }> {
  const adapter = deps.adapter ?? getDatasetAdapter(connection.provider);
  try {
    const rows = await withTimeout(adapter(connection, ctx), deps.timeoutMs);
    return { rows };
  } catch (err) {
    return classifyDatasetFetchError(err);
  }
}
