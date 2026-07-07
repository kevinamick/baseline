import { describe, it, expect, vi, beforeEach } from "vitest";

// request-context.ts has `import "server-only"`, which throws outside a server bundle.
vi.mock("server-only", () => ({}));

// The store rides React `cache()`, whose memoization is per-request and so degrades to a
// fresh object on every call in the node test env (no request scope). Model its in-request
// behavior — the factory runs once, every caller shares the result — so the round-trip the
// store relies on in production is actually exercised here.
vi.mock("react", () => ({
  cache: <T,>(fn: () => T) => {
    let cached: { value: T } | null = null;
    return () => (cached ??= { value: fn() }).value;
  },
}));

beforeEach(() => {
  // Fresh module registry → fresh memoized store per test.
  vi.resetModules();
});

describe("request log context", () => {
  it("round-trips a patched org_id within the same scope", async () => {
    const { setLogContext, currentLogContext } = await import("../request-context");
    expect(currentLogContext()).toEqual({});
    setLogContext({ org_id: "org_acme" });
    expect(currentLogContext()).toEqual({ org_id: "org_acme" });
  });

  it("merges successive patches onto the same context object", async () => {
    const { setLogContext, currentLogContext } = await import("../request-context");
    setLogContext({ org_id: "org_1" });
    setLogContext({ org_id: "org_2" }); // a later resolve wins, like the worker scope
    expect(currentLogContext()).toEqual({ org_id: "org_2" });
  });

  it("reads as empty before any patch", async () => {
    const { currentLogContext } = await import("../request-context");
    expect(currentLogContext()).toEqual({});
  });

  it("merges user_id and org_id from separate patches onto one context", async () => {
    const { setLogContext, currentLogContext } = await import("../request-context");
    setLogContext({ user_id: "user_42" }); // seeded as soon as identity resolves
    setLogContext({ org_id: "org_acme" }); // patched in once membership resolves
    expect(currentLogContext()).toEqual({ user_id: "user_42", org_id: "org_acme" });
  });
});
