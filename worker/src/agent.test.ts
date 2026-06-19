import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { AgentEndpointError, invokeAgent, resolveCandidatePrompts, type AgentConnection } from "./agent.js";
import { AGENT_ENDPOINT_ERROR_TYPE } from "./gepa/circuit-breaker.js";
import { safeFetch, BlockedRequestError } from "./safe-fetch.js";

// invokeAgent talks to a customer endpoint via safeFetch (#219); we mock that module so these
// run as a self-contained vertical slice (no Temporal, no network, no DNS). Each test asserts
// on the body the connection's template renders before POSTing. safe-fetch.test.ts covers the
// egress guard itself.
// Stub only safeFetch (the network call); keep the real, pure tenantRequestHeaders and
// BlockedRequestError so the header allowlist the adapter actually computes is under test.
vi.mock("./safe-fetch.js", async (importActual) => {
  const actual = await importActual<typeof import("./safe-fetch.js")>();
  return { ...actual, safeFetch: vi.fn() };
});

const mockSafeFetch = safeFetch as unknown as Mock;

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

const ROW = {
  row_index: 0,
  user_input: "What is your refund policy?",
  expected_output: null,
  retrieval_context: null,
};

// An agent whose request body splices both a row placeholder and a {{prompt:}} Module.
function connection(overrides: Partial<AgentConnection> = {}): AgentConnection {
  return {
    id: "conn_1",
    kind: "agent",
    endpoint: "https://agent.example.com/run",
    auth_header: null,
    auth_secret_id: null,
    request_template: { system: "{{prompt:system}}", message: "{{user_input}}" },
    response_path: "output",
    optimizable_prompts: [{ name: "system", seed: "You are a helpful support agent." }],
    ...overrides,
  };
}

beforeEach(() => {
  mockSafeFetch.mockReset();
  mockSafeFetch.mockResolvedValue(jsonResponse({ output: "answer" }));
});

function sentBody(): Record<string, unknown> {
  return JSON.parse((mockSafeFetch.mock.calls[0][1] as { body: string }).body);
}

describe("invokeAgent prompt rendering", () => {
  it("renders a Module's seed into {{prompt:}} when no candidate is supplied", async () => {
    await invokeAgent(connection(), ROW, null);
    expect(sentBody()).toEqual({
      system: "You are a helpful support agent.",
      message: "What is your refund policy?",
    });
  });

  it("renders the candidate's prompt over the seed, alongside the row placeholder", async () => {
    await invokeAgent(connection(), ROW, null, { system: "You are a terse expert." });
    expect(sentBody()).toEqual({
      system: "You are a terse expert.",
      message: "What is your refund policy?",
    });
  });

  it("renders each Module for a multi-Module agent from the candidate map", async () => {
    const conn = connection({
      request_template: {
        system: "{{prompt:system}}",
        examples: "{{prompt:few_shot}}",
        message: "{{user_input}}",
      },
      optimizable_prompts: [
        { name: "system", seed: "seed system" },
        { name: "few_shot", seed: "seed examples" },
      ],
    });
    await invokeAgent(conn, ROW, null, { system: "tuned system", few_shot: "tuned examples" });
    expect(sentBody()).toEqual({
      system: "tuned system",
      examples: "tuned examples",
      message: "What is your refund policy?",
    });
  });

  it("falls back to seeds for Modules the candidate omits (partial optimization)", async () => {
    const conn = connection({
      request_template: { system: "{{prompt:system}}", style: "{{prompt:style}}" },
      optimizable_prompts: [
        { name: "system", seed: "seed system" },
        { name: "style", seed: "seed style" },
      ],
    });
    await invokeAgent(conn, ROW, null, { system: "tuned system" });
    expect(sentBody()).toEqual({ system: "tuned system", style: "seed style" });
  });

  it("rejects a candidate referencing a Module the Connection does not declare", async () => {
    await expect(
      invokeAgent(connection(), ROW, null, { nonexistent: "x" })
    ).rejects.toThrow(/not declared/);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it("rejects (without calling the endpoint) when the template references an undeclared Module", async () => {
    // Typo: declares `system` but the template renders {{prompt:systme}}.
    const conn = connection({ request_template: { system: "{{prompt:systme}}" } });
    await expect(invokeAgent(conn, ROW, null)).rejects.toThrow(/systme/);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it("rejects an Object.prototype-named Module reference that isn't declared", async () => {
    // `toString` would pass a naive `name in prompts` guard and render the native function.
    const conn = connection({
      request_template: { system: "{{prompt:toString}}" },
      optimizable_prompts: [{ name: "system", seed: "s" }],
    });
    await expect(invokeAgent(conn, ROW, null)).rejects.toThrow(/toString/);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it("ignores {{prompt:}} tokens in object keys (renderer never substitutes keys)", async () => {
    // The key is never rendered, so an undeclared ref there must not trip the guard.
    const conn = connection({
      request_template: { "{{prompt:ghost}}": "literal", message: "{{user_input}}" },
      optimizable_prompts: [{ name: "system", seed: "s" }],
    });
    await invokeAgent(conn, ROW, null);
    expect(sentBody()).toEqual({
      "{{prompt:ghost}}": "literal",
      message: "What is your refund policy?",
    });
  });

  it("leaves a plain {{user_input}} agent (no Modules) unchanged", async () => {
    const conn = connection({
      request_template: { input: "{{user_input}}" },
      optimizable_prompts: null,
    });
    await invokeAgent(conn, ROW, null);
    expect(sentBody()).toEqual({ input: "What is your refund policy?" });
  });

  it("returns the value at the response path", async () => {
    mockSafeFetch.mockResolvedValue(jsonResponse({ output: "live answer" }));
    expect(await invokeAgent(connection(), ROW, null)).toBe("live answer");
  });

  it("throws AgentEndpointError on a non-2xx response", async () => {
    mockSafeFetch.mockResolvedValue(jsonResponse({}, false, 503));
    await expect(invokeAgent(connection(), ROW, null)).rejects.toMatchObject({
      name: "AgentEndpointError",
      message: expect.stringContaining("503"),
    });
  });

  it("throws AgentEndpointError when the endpoint is unreachable (fetch rejects)", async () => {
    mockSafeFetch.mockRejectedValue(new TypeError("fetch failed"));
    await expect(invokeAgent(connection(), ROW, null)).rejects.toMatchObject({
      name: "AgentEndpointError",
      message: expect.stringContaining("unreachable"),
    });
  });

  it("surfaces an egress-guard block as AgentEndpointError (circuit-breaker contract)", async () => {
    // A blocked SSRF target must trip the same breaker a dead endpoint does (#219), so the
    // class name stays AgentEndpointError even though the cause is a policy block.
    mockSafeFetch.mockRejectedValue(
      new BlockedRequestError("resolves to blocked address 169.254.169.254")
    );
    await expect(invokeAgent(connection(), ROW, null)).rejects.toMatchObject({
      name: "AgentEndpointError",
      message: expect.stringContaining("blocked by egress guard"),
    });
  });
});

describe("invokeAgent outbound header allowlist (#222)", () => {
  // The tenant endpoint is attacker-controlled; the call must carry ONLY the headers it
  // legitimately needs and never an internal/telemetry header. invokeAgent enforces this by
  // passing an explicit `allowedHeaders` to safeFetch, which drops everything else.
  function sentInit(): { headers: Record<string, string>; allowedHeaders: string[] } {
    return mockSafeFetch.mock.calls[0][1];
  }

  it("sends only Content-Type when the Connection declares no auth header", async () => {
    await invokeAgent(connection({ auth_header: null }), ROW, null);
    const { allowedHeaders } = sentInit();
    expect(allowedHeaders).toEqual(["Content-Type"]);
  });

  it("allows the Connection's configured auth header alongside Content-Type", async () => {
    await invokeAgent(connection({ auth_header: "X-Api-Key" }), ROW, "k3y");
    const { headers, allowedHeaders } = sentInit();
    expect(allowedHeaders).toEqual(["Content-Type", "X-Api-Key"]);
    // And the auth value is the header it set — nothing else identifying is in the map.
    expect(headers).toEqual({ "Content-Type": "application/json", "X-Api-Key": "k3y" });
  });

  it("never lists a trace/telemetry header name in the allowlist", async () => {
    await invokeAgent(connection({ auth_header: "Authorization" }), ROW, "Bearer t");
    const { allowedHeaders } = sentInit();
    for (const banned of ["traceparent", "tracestate", "baggage", "x-org-id", "x-posthog-key"]) {
      expect(allowedHeaders.map((h) => h.toLowerCase())).not.toContain(banned);
    }
  });
});

describe("AgentEndpointError", () => {
  it("constructor name matches the circuit breaker's marker type", () => {
    // Temporal derives an ApplicationFailure's `type` from the error's constructor name, so a
    // drift here would silently stop the circuit breaker from recognizing endpoint failures.
    expect(new AgentEndpointError("x").constructor.name).toBe(AGENT_ENDPOINT_ERROR_TYPE);
  });
});

describe("resolveCandidatePrompts", () => {
  const modules = [
    { name: "system", seed: "seed system" },
    { name: "style", seed: "seed style" },
  ];

  it("uses seeds when there is no candidate", () => {
    expect(resolveCandidatePrompts(modules)).toEqual({
      system: "seed system",
      style: "seed style",
    });
  });

  it("overlays candidate prompts on top of seeds", () => {
    expect(resolveCandidatePrompts(modules, { system: "tuned" })).toEqual({
      system: "tuned",
      style: "seed style",
    });
  });

  it("throws listing every undeclared Module in the candidate", () => {
    expect(() => resolveCandidatePrompts(modules, { ghost: "a", phantom: "b" })).toThrow(
      /ghost, phantom/
    );
  });

  it("returns an empty map when no Modules are declared", () => {
    expect(resolveCandidatePrompts(null)).toEqual({});
    expect(resolveCandidatePrompts(undefined)).toEqual({});
  });

  it("resolves a Module named like an Object.prototype member to its seed, not the function", () => {
    // Without hasOwnProperty, `candidate?.["toString"]` would read the inherited function.
    expect(resolveCandidatePrompts([{ name: "toString", seed: "seed text" }])).toEqual({
      toString: "seed text",
    });
    expect(
      resolveCandidatePrompts([{ name: "toString", seed: "seed text" }], { toString: "tuned" })
    ).toEqual({ toString: "tuned" });
  });

  it("lets an explicit empty-string candidate override the seed (deliberate clear)", () => {
    expect(resolveCandidatePrompts([{ name: "system", seed: "seed" }], { system: "" })).toEqual({
      system: "",
    });
  });

  it("rejects duplicate declared Module names (DB trust boundary)", () => {
    expect(() =>
      resolveCandidatePrompts([
        { name: "system", seed: "a" },
        { name: "system", seed: "b" },
      ])
    ).toThrow(/duplicate/);
  });
});
