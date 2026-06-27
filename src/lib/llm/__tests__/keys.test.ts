import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

// keys.ts imports the service-role client at module scope. Stub it so this unit
// test stays self-contained — only the pure validateProviderKey function is
// exercised here; the DB-backed round-trip is covered by keys.integration.test.ts.
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));
vi.mock("@/lib/logging/server", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { validateProviderKey } from "@/lib/llm/keys";

describe("validateProviderKey (#342)", () => {
  it("accepts a well-formed Anthropic key", () => {
    expect(validateProviderKey("anthropic", "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBeNull();
  });

  it("accepts a well-formed OpenAI key", () => {
    expect(validateProviderKey("openai", "sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBeNull();
  });

  it("accepts a well-formed Google key", () => {
    expect(validateProviderKey("google", "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX")).toBeNull();
  });

  it("accepts a well-formed Mistral key", () => {
    expect(validateProviderKey("mistral", "AbCdEf1234567890XyZ")).toBeNull();
  });

  it("rejects a fake Anthropic key with a wrong prefix", () => {
    const result = validateProviderKey("anthropic", "fake-key-that-is-long-enough-to-pass-length-check");
    expect(result).toContain("Anthropic");
    expect(result).toContain("sk-ant-");
  });

  it("rejects a key that is too short", () => {
    const result = validateProviderKey("anthropic", "sk-ant-short");
    expect(result).toContain("too short");
  });

  it("rejects a garbage string for OpenAI", () => {
    const result = validateProviderKey("openai", "not-a-real-key-but-long-enough");
    expect(result).toContain("OpenAI");
    expect(result).toContain("sk-");
  });

  it("rejects a Google key without the AIza prefix", () => {
    const result = validateProviderKey("google", "AIXXXX-not-google-prefixed-long-enough-string");
    expect(result).toContain("Google");
    expect(result).toContain("AIza");
  });

  it("rejects a Mistral key with special characters", () => {
    const result = validateProviderKey("mistral", "key-with-dashes-and-special!chars");
    expect(result).toContain("Mistral");
  });
});
