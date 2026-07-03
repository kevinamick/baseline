import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { customDatasetAdapter } from "./custom.js";
import { posthogDatasetAdapter } from "./posthog.js";
import { getDatasetAdapter } from "./index.js";
import { safeFetch } from "../safe-fetch.js";
import type { DatasetConnection, FetchContext } from "./types.js";

// The adapters reach customer endpoints via safeFetch (#219); we stub only that network call so
// these stay self-contained (no network, no DNS). The real, pure tenantRequestHeaders is kept so
// the header allowlist the adapter computes is exercised. safe-fetch.test.ts covers the guard.
vi.mock("../safe-fetch.js", async (importActual) => {
  const actual = await importActual<typeof import("../safe-fetch.js")>();
  return { ...actual, safeFetch: vi.fn() };
});

const mockFetch = safeFetch as unknown as Mock;

const CTX: FetchContext = {
  windowStart: "2026-05-30T00:00:00.000Z",
  windowEnd: "2026-05-31T00:00:00.000Z",
  maxRows: 100,
  authValue: "Bearer s3cr3t",
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  mockFetch.mockReset();
});

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
    // Outbound header allowlist (#222): only the Connection's auth header may be sent (no body
    // → no Content-Type). safeFetch drops anything else, so no internal header can leak.
    expect((opts as { allowedHeaders: string[] }).allowedHeaders).toEqual(["Authorization"]);

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

  it("treats an unmapped field as empty, not the whole row stringified", async () => {
    const noMap: DatasetConnection = { ...base, config: { field_map: { user_input: "prompt" } } };
    mockFetch.mockResolvedValue(jsonResponse({ data: [{ prompt: "hi", completion: "yo" }] }));
    const rows = await customDatasetAdapter(noMap, CTX);
    // agent_output has no configured path → "" (so the row is later filtered as unusable),
    // never the entire row JSON.
    expect(rows).toEqual([
      { user_input: "hi", agent_output: "", expected_output: null, retrieval_context: null },
    ]);
  });

  it("treats an unmapped user_input the same way — empty, not the whole row", async () => {
    const onlyOutputMapped: DatasetConnection = {
      ...base,
      config: { field_map: { agent_output: "completion" } },
    };
    mockFetch.mockResolvedValue(jsonResponse({ data: [{ prompt: "hi", completion: "yo" }] }));
    const rows = await customDatasetAdapter(onlyOutputMapped, CTX);
    expect(rows).toEqual([
      { user_input: "", agent_output: "yo", expected_output: null, retrieval_context: null },
    ]);
  });

  it("sends no query params (and no request_template branch) when request_template is absent", async () => {
    const noTemplate: DatasetConnection = { ...base, request_template: null };
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await customDatasetAdapter(noTemplate, CTX);
    const [url] = mockFetch.mock.calls[0];
    const u = new URL(url as string | URL);
    expect([...u.searchParams.keys()]).toEqual([]);
  });

  it("JSON-stringifies a rendered template value that isn't a string", async () => {
    // renderTemplate passes non-string primitives through unchanged; the adapter must still
    // produce a valid query-param string rather than [object Object]/NaN.
    const numericTemplate: DatasetConnection = { ...base, request_template: { limit: 100 } };
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await customDatasetAdapter(numericTemplate, CTX);
    const [url] = mockFetch.mock.calls[0];
    const u = new URL(url as string | URL);
    expect(u.searchParams.get("limit")).toBe("100");
  });

  it("defaults to an empty field_map when config has no field_map (or no config)", async () => {
    const noFieldMap: DatasetConnection = { ...base, config: {} };
    mockFetch.mockResolvedValue(jsonResponse({ data: [{ prompt: "hi", completion: "yo" }] }));
    const rows = await customDatasetAdapter(noFieldMap, CTX);
    expect(rows).toEqual([
      { user_input: "", agent_output: "", expected_output: null, retrieval_context: null },
    ]);

    const noConfig: DatasetConnection = { ...base, config: null };
    mockFetch.mockResolvedValue(jsonResponse({ data: [{ prompt: "hi", completion: "yo" }] }));
    const rows2 = await customDatasetAdapter(noConfig, CTX);
    expect(rows2).toEqual([
      { user_input: "", agent_output: "", expected_output: null, retrieval_context: null },
    ]);
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
    // Outbound header allowlist (#222): only Content-Type + the Connection's auth header.
    expect((opts as { allowedHeaders: string[] }).allowedHeaders).toEqual([
      "Content-Type",
      "Authorization",
    ]);

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

  it("throws the same way when config itself is null", async () => {
    await expect(posthogDatasetAdapter({ ...conn, config: null }, CTX)).rejects.toThrow(
      /missing project_id or hogql/
    );
  });

  it("accepts other posthog.com subdomains (e.g. the EU region)", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ columns: [], results: [] }));
    await posthogDatasetAdapter({ ...conn, endpoint: "https://eu.posthog.com" }, CTX);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://eu.posthog.com/api/projects/440128/query/");
  });

  it("rejects a non-PostHog host and never issues the request (#221)", async () => {
    await expect(
      posthogDatasetAdapter({ ...conn, endpoint: "https://evil.example.com" }, CTX)
    ).rejects.toThrow(/not an allowed PostHog host/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects a look-alike host that merely contains posthog.com (#221)", async () => {
    await expect(
      posthogDatasetAdapter({ ...conn, endpoint: "https://posthog.com.attacker.example" }, CTX)
    ).rejects.toThrow(/not an allowed PostHog host/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects a malformed endpoint URL (#221)", async () => {
    await expect(
      posthogDatasetAdapter({ ...conn, endpoint: "not a url" }, CTX)
    ).rejects.toThrow(/not a valid URL/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws on a non-OK HTTP status from the query API", async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, false, 500));
    await expect(posthogDatasetAdapter(conn, CTX)).rejects.toThrow(/HTTP 500/);
  });

  it("defaults to no rows when the response has no columns/results fields at all", async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));
    const rows = await posthogDatasetAdapter(conn, CTX);
    expect(rows).toEqual([]);
  });

  it("leaves user_input/agent_output empty when those columns aren't in the result set", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        columns: ["expected_output"],
        results: [["only-expected"]],
      })
    );
    const rows = await posthogDatasetAdapter(conn, CTX);
    expect(rows).toEqual([
      { user_input: "", agent_output: "", expected_output: "only-expected", retrieval_context: null },
    ]);
  });

  it("defaults a mapped but null/undefined cell value to empty string, not null", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        columns: ["user_input", "agent_output"],
        results: [[null, "hello"]],
      })
    );
    const rows = await posthogDatasetAdapter(conn, CTX);
    expect(rows[0].user_input).toBe("");
  });

  it("defaults a null agent_output cell to empty string too", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        columns: ["user_input", "agent_output"],
        results: [["hi", null]],
      })
    );
    const rows = await posthogDatasetAdapter(conn, CTX);
    expect(rows[0].agent_output).toBe("");
  });

  it("maps expected_output and retrieval_context columns when the query selects them", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        columns: ["user_input", "agent_output", "expected_output", "retrieval_context"],
        results: [["hi", "hello", "expected-hi", { doc: "ctx" }]],
      })
    );
    const rows = await posthogDatasetAdapter(conn, CTX);
    expect(rows).toEqual([
      {
        user_input: "hi",
        agent_output: "hello",
        expected_output: "expected-hi",
        retrieval_context: JSON.stringify({ doc: "ctx" }),
      },
    ]);
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
