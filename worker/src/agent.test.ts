import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { invokeAgent, resolveCandidatePrompts, type AgentConnection } from "./agent.js";

// invokeAgent talks to a customer endpoint over fetch; we stub it so these run as a
// self-contained vertical slice (no Temporal, no network). Each test asserts on the body
// the connection's template renders before POSTing.

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

let mockFetch: Mock;

beforeEach(() => {
  mockFetch = vi.fn().mockResolvedValue(jsonResponse({ output: "answer" }));
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => vi.unstubAllGlobals());

function sentBody(): Record<string, unknown> {
  return JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
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
    expect(mockFetch).not.toHaveBeenCalled();
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
    mockFetch.mockResolvedValue(jsonResponse({ output: "live answer" }));
    expect(await invokeAgent(connection(), ROW, null)).toBe("live answer");
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
});
