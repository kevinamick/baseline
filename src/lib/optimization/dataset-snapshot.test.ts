import { describe, expect, it, vi } from "vitest";

// dataset-snapshot.ts (and dataset-fetch.ts underneath it) has `import "server-only"`, which
// throws outside a server bundle.
vi.mock("server-only", () => ({}));

import { snapshotDatasetInstances, DATASET_SNAPSHOT_TIMEOUT_MS } from "./dataset-snapshot";
import { MAX_OPTIMIZATION_INSTANCES } from "@/lib/validation/schemas";
import type { DatasetConnection, DatasetRow, FetchContext } from "../../../worker/src/adapters";

const CONNECTION: DatasetConnection = {
  id: "conn-1",
  kind: "dataset",
  provider: "custom",
  endpoint: "https://api.example.com/logs",
  auth_header: "Authorization",
  auth_secret_id: null,
  request_template: { limit: "{{max_rows}}" },
  response_path: "data",
  config: { field_map: { user_input: "prompt", agent_output: "completion" } },
};

function row(userInput: string, overrides: Partial<DatasetRow> = {}): DatasetRow {
  return {
    user_input: userInput,
    agent_output: "some historical output",
    expected_output: null,
    retrieval_context: null,
    ...overrides,
  };
}

describe("snapshotDatasetInstances — mapping", () => {
  it("maps user_input/expected_output/retrieval_context and drops agent_output", async () => {
    const adapter = async () => [row("Q1", { expected_output: "A1", retrieval_context: "ctx" })];
    const result = await snapshotDatasetInstances(CONNECTION, "Bearer x", 60, { adapter });
    expect(result).toEqual({
      instances: [{ userInput: "Q1", expectedOutput: "A1", retrievalContext: "ctx" }],
    });
  });

  it("skips rows without a usable user_input", async () => {
    const adapter = async () => [row(""), row("   "), row("Q2")];
    const result = await snapshotDatasetInstances(CONNECTION, null, 60, { adapter });
    expect("instances" in result && result.instances).toEqual([
      { userInput: "Q2", expectedOutput: null, retrievalContext: null },
    ]);
  });

  it("returns an empty instance list (not an error) when the window has no usable rows", async () => {
    const result = await snapshotDatasetInstances(CONNECTION, null, 60, {
      adapter: async () => [],
    });
    expect(result).toEqual({ instances: [] });
  });
});

describe("snapshotDatasetInstances — bounds", () => {
  it("requests the adapter for exactly the instance cap, over the given window", async () => {
    const calls: FetchContext[] = [];
    const adapter = async (_conn: DatasetConnection, ctx: FetchContext) => {
      calls.push(ctx);
      return [];
    };
    await snapshotDatasetInstances(CONNECTION, null, 1440, {
      adapter,
      now: () => new Date("2026-07-05T12:00:00.000Z"),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].maxRows).toBe(MAX_OPTIMIZATION_INSTANCES);
    expect(calls[0].windowEnd).toBe("2026-07-05T12:00:00.000Z");
    // 1440 minutes = 24 hours before "now".
    expect(calls[0].windowStart).toBe("2026-07-04T12:00:00.000Z");
  });

  it("caps mapped rows at the instance cap even if the source over-returns (most recent taken)", async () => {
    // The adapter is asked for MAX_OPTIMIZATION_INSTANCES rows; a source that ignores the
    // pushed-down limit and over-returns must not flood the frozen instance set.
    const many = Array.from({ length: MAX_OPTIMIZATION_INSTANCES + 20 }, (_, i) => row(`q-${i}`));
    const result = await snapshotDatasetInstances(CONNECTION, null, 60, {
      adapter: async () => many,
    });
    expect("instances" in result && result.instances).toHaveLength(MAX_OPTIMIZATION_INSTANCES);
  });
});

describe("snapshotDatasetInstances — error classification", () => {
  it("surfaces a timeout when the source hangs", async () => {
    const result = await snapshotDatasetInstances(CONNECTION, null, 60, {
      adapter: () => new Promise<DatasetRow[]>(() => {}), // never settles
      timeoutMs: 20,
    });
    expect("error" in result && result.error).toBe("timeout");
  });

  it("defaults to the longer intake timeout, not the preview's", () => {
    expect(DATASET_SNAPSHOT_TIMEOUT_MS).toBeGreaterThan(15_000);
  });

  it("classifies an SSRF/policy refusal (BlockedRequestError) as an endpoint error", async () => {
    const adapter = async () => {
      const err = new Error("Refusing to connect to evil: resolves to blocked address 10.0.0.1");
      err.name = "BlockedRequestError";
      throw err;
    };
    const result = await snapshotDatasetInstances(CONNECTION, null, 60, { adapter });
    expect("error" in result && result.error).toBe("endpoint");
  });
});

// Proves the intake really drives the worker's adapter seam (not a reimplementation) AND
// inherits its SSRF egress guard: with no injected adapter it resolves the real custom adapter,
// whose safeFetch refuses a private/reserved target before any connect. Mirrors
// preview.test.ts's "real adapter seam + SSRF guard" test for the "Test query" preview.
describe("snapshotDatasetInstances — real adapter seam + SSRF guard", () => {
  it("refuses a private/loopback endpoint via the worker's safeFetch (no adapter injected)", async () => {
    const result = await snapshotDatasetInstances(
      { ...CONNECTION, endpoint: "https://127.0.0.1/logs" },
      null,
      60
    );
    expect("error" in result && result.error).toBe("endpoint");
  });
});
