import { describe, expect, it, vi } from "vitest";

// preview.ts has `import "server-only"`, which throws outside a server bundle.
vi.mock("server-only", () => ({}));

import { runDatasetPreview } from "./preview";
import {
  PREVIEW_MAX_ROWS,
  PREVIEW_WINDOW_MINUTES,
  type PreviewResult,
} from "./preview-types";
import type { DatasetPreviewInput } from "@/lib/validation/schemas";
import type {
  DatasetConnection,
  DatasetRow,
  FetchContext,
} from "../../../worker/src/adapters";

const POSTHOG_SPEC: DatasetPreviewInput = {
  type: "posthog_dataset",
  host: "https://us.posthog.com",
  projectId: "12345",
  apiKey: "phx_secret",
  hogql: "SELECT a AS user_input, b AS agent_output FROM events LIMIT {{max_rows}}",
};

const CUSTOM_SPEC: DatasetPreviewInput = {
  type: "custom_dataset",
  endpoint: "https://api.example.com/logs",
  authHeader: "Authorization",
  authValue: "Bearer t0ken",
  requestTemplate: '{"from":"{{window_start}}","limit":"{{max_rows}}"}',
  responsePath: "data",
  fieldMap: { userInput: "prompt", agentOutput: "completion" },
};

const ROW: DatasetRow = {
  user_input: "hi",
  agent_output: "hello",
  expected_output: null,
  retrieval_context: null,
};

// Capture the (connection, ctx) the preview hands the adapter, so we can assert the seam is fed
// exactly what a saved schedule would feed it.
function capturingAdapter(rows: DatasetRow[]) {
  const calls: { connection: DatasetConnection; ctx: FetchContext }[] = [];
  const adapter = async (connection: DatasetConnection, ctx: FetchContext) => {
    calls.push({ connection, ctx });
    return rows;
  };
  return { adapter, calls };
}

describe("runDatasetPreview — adapter seam wiring", () => {
  it("builds a PostHog DatasetConnection + bounded FetchContext and maps the rows", async () => {
    const { adapter, calls } = capturingAdapter([ROW]);
    const now = () => new Date("2026-06-25T12:00:00.000Z");

    const result = await runDatasetPreview(POSTHOG_SPEC, { adapter, now });

    expect(calls).toHaveLength(1);
    const { connection, ctx } = calls[0];
    expect(connection.provider).toBe("posthog");
    expect(connection.endpoint).toBe("https://us.posthog.com");
    expect(connection.auth_header).toBe("Authorization");
    expect(connection.response_path).toBe("results");
    expect(connection.config).toEqual({ project_id: "12345", hogql: POSTHOG_SPEC.hogql });
    // The raw key is sent as the full header value, exactly like create.ts persists it.
    expect(ctx.authValue).toBe("Bearer phx_secret");
    // Bounded: 5 rows, a 60-minute window ending "now".
    expect(ctx.maxRows).toBe(PREVIEW_MAX_ROWS);
    expect(ctx.windowEnd).toBe("2026-06-25T12:00:00.000Z");
    expect(ctx.windowStart).toBe("2026-06-25T11:00:00.000Z");

    expect(result).toEqual({ rows: [ROW] });
  });

  it("builds a custom DatasetConnection with parsed template + field_map and live auth", async () => {
    const { adapter, calls } = capturingAdapter([ROW]);

    await runDatasetPreview(CUSTOM_SPEC, { adapter });

    const { connection, ctx } = calls[0];
    expect(connection.provider).toBe("custom");
    expect(connection.endpoint).toBe("https://api.example.com/logs");
    expect(connection.auth_header).toBe("Authorization");
    expect(connection.request_template).toEqual({
      from: "{{window_start}}",
      limit: "{{max_rows}}",
    });
    expect(connection.response_path).toBe("data");
    expect(connection.config).toEqual({
      field_map: { user_input: "prompt", agent_output: "completion" },
    });
    expect(ctx.authValue).toBe("Bearer t0ken");
  });

  it("caps returned rows to the row limit even if the source over-returns", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...ROW, user_input: `row-${i}` }));
    const { adapter } = capturingAdapter(many);

    const result = await runDatasetPreview(POSTHOG_SPEC, { adapter });

    expect("rows" in result && result.rows).toHaveLength(PREVIEW_MAX_ROWS);
  });

  it("uses the default 60-minute window", async () => {
    const { adapter, calls } = capturingAdapter([ROW]);
    const now = () => new Date("2026-06-25T12:00:00.000Z");

    await runDatasetPreview(POSTHOG_SPEC, { adapter, now });

    const diffMs =
      new Date(calls[0].ctx.windowEnd).getTime() - new Date(calls[0].ctx.windowStart).getTime();
    expect(diffMs).toBe(PREVIEW_WINDOW_MINUTES * 60_000);
  });
});

describe("runDatasetPreview — error classification", () => {
  function failing(message: string, name?: string) {
    return async () => {
      const err = new Error(message);
      if (name) err.name = name;
      throw err;
    };
  }

  it("classifies a 401 as an auth error and passes the detail through", async () => {
    const result = await runDatasetPreview(POSTHOG_SPEC, {
      adapter: failing("PostHog query returned HTTP 401"),
    });
    expect(result).toEqual({ error: "auth", detail: "PostHog query returned HTTP 401" });
  });

  it("classifies an unresolved rows path", async () => {
    const result = await runDatasetPreview(CUSTOM_SPEC, {
      adapter: failing("Dataset response_path 'data' did not resolve to an array"),
    });
    expect("error" in result && result.error).toBe("rows_path");
  });

  it("classifies an SSRF/policy refusal (BlockedRequestError) as an endpoint error", async () => {
    const result = await runDatasetPreview(CUSTOM_SPEC, {
      adapter: failing("Refusing to connect to evil: resolves to blocked address 10.0.0.1", "BlockedRequestError"),
    });
    expect("error" in result && result.error).toBe("endpoint");
  });

  it("classifies a non-JSON response body as a parse error", async () => {
    const result = await runDatasetPreview(CUSTOM_SPEC, {
      adapter: async () => {
        JSON.parse("<html>not json</html>");
        return [];
      },
    });
    expect("error" in result && result.error).toBe("parse");
  });

  it("returns a config error for an invalid request template (no adapter call)", async () => {
    const adapter = vi.fn();
    const result = await runDatasetPreview(
      { ...CUSTOM_SPEC, requestTemplate: "{ not json" },
      { adapter }
    );
    expect("error" in result && result.error).toBe("config");
    expect(adapter).not.toHaveBeenCalled();
  });

  it("enforces the timeout when the source hangs", async () => {
    const result = await runDatasetPreview(POSTHOG_SPEC, {
      adapter: () => new Promise<DatasetRow[]>(() => {}), // never settles
      timeoutMs: 20,
    });
    expect("error" in result && result.error).toBe("timeout");
  });
});

describe("runDatasetPreview — mapping warnings", () => {
  it("warns when rows come back but nothing maps into the required fields", async () => {
    const blank: DatasetRow = {
      user_input: "",
      agent_output: "",
      expected_output: null,
      retrieval_context: null,
    };
    const result: PreviewResult = await runDatasetPreview(POSTHOG_SPEC, {
      adapter: async () => [blank, blank],
    });
    expect(result).toEqual({ rows: [blank, blank], warning: "no_columns_mapped" });
  });

  it("returns an empty row list without a warning when the source has no rows", async () => {
    const result = await runDatasetPreview(POSTHOG_SPEC, { adapter: async () => [] });
    expect(result).toEqual({ rows: [] });
  });
});

// Proves the preview really drives the worker's adapter seam (not a reimplementation) AND
// inherits its SSRF egress guard: with no injected adapter it resolves the real
// posthog/custom adapter, whose safeFetch refuses a private/reserved target before any connect.
describe("runDatasetPreview — real adapter seam + SSRF guard", () => {
  it("refuses a private endpoint via the worker's safeFetch (no adapter injected)", async () => {
    const result = await runDatasetPreview({
      ...CUSTOM_SPEC,
      endpoint: "https://127.0.0.1/logs",
    });
    expect("error" in result && result.error).toBe("endpoint");
  });
});
