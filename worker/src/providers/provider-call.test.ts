import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApplicationFailure } from "@temporalio/common";

const { mockResolveProviderKey, mockCreateProvider, mockLogWarn } = vi.hoisted(() => ({
  mockResolveProviderKey: vi.fn(),
  mockCreateProvider: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock("./resolve-key.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resolve-key.js")>()),
  resolveProviderKey: mockResolveProviderKey,
}));
vi.mock("./factory.js", () => ({ createProvider: mockCreateProvider }));
vi.mock("../log.js", () => ({
  log: { warn: mockLogWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  providerCall,
  resolveProviderCall,
  runProviderCall,
  resolveKeyForModel,
  type ProviderCallScope,
} from "./provider-call.js";
import { ProviderHttpError } from "./http.js";

const TERMINALS = { missingKey: "MISSING_KEY", modelUnavailable: "MODEL_UNAVAILABLE" };
const scope: ProviderCallScope = {
  supabase: {} as SupabaseClient,
  orgId: "org-1",
  run: { evalRunId: "run-1" },
  terminals: TERMINALS,
};
const providerStub = { judge: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateProvider.mockReturnValue(providerStub);
});

function failureType(err: unknown): string | undefined {
  return (err as { type?: string }).type;
}

describe("providerCall — resolution", () => {
  it("no key: throws the scope's missingKey terminal marker before building anything", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "none" });
    const execute = vi.fn();
    const err = await providerCall({
      scope,
      resolveKey: () => resolveKeyForModel(scope.supabase, "org-1", "claude-haiku-4-5-20251001"),
      execute,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(failureType(err)).toBe("MISSING_KEY");
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
    expect(mockCreateProvider).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("saved key: builds the provider with the resolved key and hands the ctx to execute", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-vault" });
    const result = await providerCall({
      scope,
      resolveKey: () => resolveKeyForModel(scope.supabase, "org-1", "claude-haiku-4-5-20251001"),
      providerOpts: (model) => ({ judgeModel: model }),
      execute: async (ctx) => ctx,
    });
    expect(mockCreateProvider).toHaveBeenCalledWith("anthropic", {
      apiKey: "sk-vault",
      judgeModel: "claude-haiku-4-5-20251001",
    });
    expect(result.source).toBe("byo");
    expect(result.providerName).toBe("anthropic");
    expect(result.provider).toBe(providerStub);
  });

  it("env key: resolves the same way with source 'env'", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "env", key: "sk-env" });
    const result = await providerCall({
      scope,
      resolveKey: () => resolveKeyForModel(scope.supabase, "org-1", "gpt-5-mini"),
      execute: async (ctx) => ctx,
    });
    expect(mockCreateProvider).toHaveBeenCalledWith("openai", { apiKey: "sk-env" });
    expect(result.source).toBe("env");
  });

  it("resolveKeyForModel honors an explicit provider (#485): no Anthropic misroute for a live model", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-o" });
    await providerCall({
      scope,
      resolveKey: () => resolveKeyForModel(scope.supabase, "org-1", "gpt-5.3-preview", "openai"),
      execute: async () => null,
    });
    expect(mockResolveProviderKey).toHaveBeenCalledWith(scope.supabase, "org-1", "openai");
    expect(mockCreateProvider).toHaveBeenCalledWith("openai", { apiKey: "sk-o" });
  });
});

describe("providerCall — catch classification", () => {
  async function callRejecting(source: "byo" | "env", err: unknown) {
    mockResolveProviderKey.mockResolvedValue({ source, key: "sk-secret" });
    return providerCall({
      scope,
      resolveKey: () => resolveKeyForModel(scope.supabase, "org-1", "claude-haiku-4-5-20251001"),
      execute: async () => {
        throw err;
      },
    }).catch((e) => e);
  }

  it("provider rejection (401): logs provider_key.byo_failed with the key source and rethrows the ORIGINAL error", async () => {
    const original = new ProviderHttpError("anthropic", 401, '{"error":{"message":"invalid x-api-key"}}');
    const err = await callRejecting("byo", original);
    expect(err).toBe(original);
    expect(mockLogWarn).toHaveBeenCalledWith(
      "Provider key was rejected by the provider",
      expect.objectContaining({
        event: "provider_key.byo_failed",
        provider: "anthropic",
        key_source: "byo",
        org_id: "org-1",
        run_id: "run-1",
        status: 401,
      }),
    );
    expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain("sk-secret");
  });

  it("an env key rejection is attributed the same way (key_source 'env')", async () => {
    const err = await callRejecting("env", new ProviderHttpError("anthropic", 403, "forbidden"));
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(mockLogWarn).toHaveBeenCalledWith(
      "Provider key was rejected by the provider",
      expect.objectContaining({ key_source: "env", status: 403 }),
    );
  });

  it("429 quota exhaustion IS attributed to the key (a genuine key-quota rejection)", async () => {
    await callRejecting("byo", new ProviderHttpError("anthropic", 429, "rate limited"));
    expect(mockLogWarn).toHaveBeenCalledWith(
      "Provider key was rejected by the provider",
      expect.objectContaining({ status: 429 }),
    );
  });

  it("404 model-not-found: converts to a nonRetryable modelUnavailable terminal, not a key blame (#488)", async () => {
    const err = await callRejecting("byo", new ProviderHttpError("anthropic", 404, "model not found"));
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(failureType(err)).toBe("MODEL_UNAVAILABLE");
    expect((err as ApplicationFailure).message).toContain("no longer available from Anthropic");
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("400 unknown-model: also converts to the modelUnavailable terminal", async () => {
    const err = await callRejecting("env", new ProviderHttpError("anthropic", 400, "bad model"));
    expect(failureType(err)).toBe("MODEL_UNAVAILABLE");
  });

  it("5xx provider blip: not attributed to the key, rethrown unchanged", async () => {
    const original = new ProviderHttpError("anthropic", 503, "unavailable");
    const err = await callRejecting("byo", original);
    expect(err).toBe(original);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("a non-provider error (e.g. a DB failure) rethrows unchanged", async () => {
    const original = new Error("db down");
    const err = await callRejecting("byo", original);
    expect(err).toBe(original);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });
});

describe("resolveProviderCall + runProviderCall — the split used for a cached per-run resolution", () => {
  it("resolves once and lets a cached context be reused across many runProviderCall executions", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-vault" });
    const ctx = await resolveProviderCall({
      scope,
      resolveKey: () => resolveKeyForModel(scope.supabase, "org-1", "claude-haiku-4-5-20251001"),
    });
    const a = await runProviderCall(scope, ctx, async (c) => c.providerName);
    const b = await runProviderCall(scope, ctx, async (c) => c.source);
    expect([a, b]).toEqual(["anthropic", "byo"]);
    expect(mockResolveProviderKey).toHaveBeenCalledTimes(1);
  });

  it("runProviderCall still classifies a per-call failure using the cached context", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-vault" });
    const ctx = await resolveProviderCall({
      scope,
      resolveKey: () => resolveKeyForModel(scope.supabase, "org-1", "claude-haiku-4-5-20251001"),
    });
    const err = await runProviderCall(scope, ctx, async () => {
      throw new ProviderHttpError("anthropic", 401, "nope");
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(mockLogWarn).toHaveBeenCalledWith(
      "Provider key was rejected by the provider",
      expect.objectContaining({ event: "provider_key.byo_failed" }),
    );
  });
});
