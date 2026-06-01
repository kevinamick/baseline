import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { customDatasetAdapter } from "./custom.js";
import { posthogDatasetAdapter } from "./posthog.js";
import { getDatasetAdapter } from "./index.js";
import type { DatasetConnection, FetchContext } from "./types.js";

const CTX: FetchContext = {
  windowStart: "2026-05-30T00:00:00.000Z",
  windowEnd: "2026-05-31T00:00:00.000Z",
  maxRows: 100,
  authValue: "Bearer s3cr3t",
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

let mockFetch: Mock;
beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("custom dataset adapter", () => {
  const base: DatasetConnection = {
    id: "c1",
    kind: "dataset",
    provider: "custom",
    endpoint: "https://api.acme.com/v1/logs",
    auth_header: "Authorization",
    auth_secret_id: "s1",
    request_template: { from: "{{window_start}}", to: "{{window_end}}", limit: "{{max_rows}}" },
    response_path: "data",
    config: { field_map: { user_input: "prompt", agent_output: "completion" } },
  };

  it("renders window/limit into query params, sends auth, and maps rows by field_map", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        data: [
          { prompt: "where's my order?", completion: "Let me check" },
          { prompt: "refund?", completion: "Started it" },
        ],
      })
    );

    const rows = await customDatasetAdapter(base, CTX);

    const [url, opts] = mockFetch.mock.calls[0];
    const u = new URL(url as string | URL);
    expect(u.origin + u.pathname).toBe("https://api.acme.com/v1/logs");
    expect(u.searchParams.get("from")).toBe(CTX.windowStart);
    expect(u.searchParams.get("to")).toBe(CTX.windowEnd);
    expect(u.searchParams.get("limit")).toBe("100");
    expect((opts as { method: string }).method).toBe("GET");
    expect((opts as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer s3cr3t");

    expect(rows).toEqual([
      { user_input: "where's my order?", agent_output: "Let me check", expected_output: null, retrieval_context: null },
      { user_input: "refund?", agent_output: "Started it", expected_output: null, retrieval_context: null },
    ]);
  });

  it("throws when the response_path does not resolve to an array", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { not: "an array" } }));
    await expect(customDatasetAdapter(base, CTX)).rejects.toThrow(/did not resolve to an array/);
  });

  it("throws on a non-OK HTTP status", async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, false, 502));
    await expect(customDatasetAdapter(base, CTX)).rejects.toThrow(/HTTP 502/);
  });
});

describe("posthog dataset adapter", () => {
  const conn: DatasetConnection = {
    id: "p1",
    kind: "dataset",
    provider: "posthog",
    endpoint: "https://us.posthog.com",
    auth_header: "Authorization",
    auth_secret_id: "s2",
    request_template: null,
    response_path: "results",
    config: {
      project_id: "440128",
      hogql:
        "SELECT a AS user_input, b AS agent_output FROM events WHERE timestamp >= '{{window_start}}' AND timestamp < '{{window_end}}' LIMIT {{max_rows}}",
    },
  };

  it("posts rendered HogQL to the query API and maps results by column alias", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        columns: ["user_input", "agent_output"],
        results: [["hi", "hello"], ["bye", "goodbye"]],
      })
    );

    const rows = await posthogDatasetAdapter(conn, CTX);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://us.posthog.com/api/projects/440128/query/");
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.query.kind).toBe("HogQLQuery");
    expect(body.query.query).toContain("'2026-05-30T00:00:00.000Z'");
    expect(body.query.query).toContain("LIMIT 100");
    expect((opts as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer s3cr3t");

    expect(rows).toEqual([
      { user_input: "hi", agent_output: "hello", expected_output: null, retrieval_context: null },
      { user_input: "bye", agent_output: "goodbye", expected_output: null, retrieval_context: null },
    ]);
  });

  it("throws when config is missing project_id or hogql", async () => {
    await expect(
      posthogDatasetAdapter({ ...conn, config: { project_id: "1" } }, CTX)
    ).rejects.toThrow(/missing project_id or hogql/);
  });
});

describe("adapter registry", () => {
  it("resolves known providers", () => {
    expect(getDatasetAdapter("custom")).toBe(customDatasetAdapter);
    expect(getDatasetAdapter("posthog")).toBe(posthogDatasetAdapter);
  });

  it("throws on an unknown provider", () => {
    expect(() => getDatasetAdapter("appinsights")).toThrow(/Unsupported dataset provider/);
  });
});
