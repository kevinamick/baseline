import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApplicationFailure } from "@temporalio/common";
import { ProviderHttpError } from "./http.js";
import {
  ManagedSpendCapExceeded,
  ManagedPaymentBlockedError,
  UnpricedManagedCallError,
} from "./managed-meter.js";

// Unit coverage for the metered-call wrapper itself (#384): the fail-closed matrix through its
// OWN interface (meteredCall), independent of any particular call site. evalrun/activities.test.ts
// and gepa/activities.*.test.ts already cover the six adopted call sites end-to-end (unchanged
// behavior — those tests mock the same underlying resolveProviderKey/createManagedMeter/
// priceForModel/createProviderForModel dependencies this module calls, so they exercise this
// wrapper transitively too).

const { mockResolveProviderKey } = vi.hoisted(() => ({ mockResolveProviderKey: vi.fn() }));
vi.mock("./resolve-key.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resolve-key.js")>()),
  resolveProviderKey: mockResolveProviderKey,
}));

const { mockCreateManagedMeter } = vi.hoisted(() => ({ mockCreateManagedMeter: vi.fn() }));
vi.mock("./managed-meter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./managed-meter.js")>()),
  createManagedMeter: mockCreateManagedMeter,
}));

const { mockPriceForModel } = vi.hoisted(() => ({ mockPriceForModel: vi.fn() }));
vi.mock("./registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./registry.js")>()),
  priceForModel: mockPriceForModel,
}));

const { mockCreateProvider } = vi.hoisted(() => ({ mockCreateProvider: vi.fn() }));
vi.mock("./factory.js", () => ({ createProvider: mockCreateProvider }));

vi.mock("../log.js", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { log } from "../log.js";
import {
  meteredCall,
  resolveMeteredCall,
  runMeteredCall,
  resolveKeyForModel,
  type MeteredCallScope,
} from "./metered-call.js";

const MODEL = "claude-sonnet-4-6";

const EVAL_SCOPE: MeteredCallScope = {
  supabase: {} as MeteredCallScope["supabase"],
  orgId: "org_1",
  run: { evalRunId: "run_1" },
  terminals: {
    missingKey: "EvalRunTerminal",
    billingBlocked: "EvalRunTerminal",
    modelUnavailable: "EvalRunTerminal",
  },
};

// A GEPA-style scope: distinct markers per failure class, so a model-unavailable terminal is
// distinguishable from a billing/key one (metered-call.ts's MeteredCallTerminals).
const OPT_SCOPE: MeteredCallScope = {
  supabase: {} as MeteredCallScope["supabase"],
  orgId: "org_1",
  run: { optRunId: "opt_1" },
  terminals: {
    missingKey: "PROVIDER_KEY_MISSING",
    billingBlocked: "MANAGED_SPEND_BLOCKED",
    modelUnavailable: "MODEL_UNAVAILABLE",
  },
};

function meter(record: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)) {
  return { record, assertPriced: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPriceForModel.mockReturnValue({
    inputUsdPerToken: 1e-6,
    outputUsdPerToken: 5e-6,
    typicalInputTokens: 100,
    typicalOutputTokens: 100,
  });
  mockCreateProvider.mockImplementation((_provider, opts) => ({ __opts: opts }));
});

describe("meteredCall — fail-closed matrix", () => {
  it("no key: throws the scope's missingKey terminal marker before building anything", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "none" });

    const execute = vi.fn();
    const thrown = await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "judge",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, MODEL),
      execute,
    }).catch((e) => e);

    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).type).toBe("EvalRunTerminal");
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(mockCreateManagedMeter).not.toHaveBeenCalled();
  });

  it("managed + unpriced model: fails closed before any meter/provider is built", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockPriceForModel.mockReturnValue(null);

    const execute = vi.fn();
    const thrown = await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "judge",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, MODEL),
      execute,
    }).catch((e) => e);

    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).type).toBe("EvalRunTerminal");
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    expect(mockCreateManagedMeter).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("managed + missing reservation (#358/#410): fails closed unconditionally — no call site can opt out", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockCreateManagedMeter.mockResolvedValue(null);

    const execute = vi.fn();
    const thrown = await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "judge",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, MODEL),
      execute,
    }).catch((e) => e);

    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).type).toBe("EvalRunTerminal");
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    expect((thrown as ApplicationFailure).message).toMatch(/managed-spend reservation/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("managed + missing reservation still fails closed for a 'reflect' callKind (GEPA's own reflect/generation calls, #410)", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockCreateManagedMeter.mockResolvedValue(null);

    const execute = vi.fn();
    const thrown = await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "reflect",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, MODEL),
      execute,
    }).catch((e) => e);

    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("managed happy path: builds the meter, hands it to execute, and record() prices with callKind", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    const record = vi.fn().mockResolvedValue(undefined);
    mockCreateManagedMeter.mockResolvedValue(meter(record));

    const result = await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "agent",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, MODEL),
      execute: async (ctx) => {
        expect(ctx.source).toBe("managed");
        expect(ctx.meter).toBeDefined();
        await ctx.record({ model: MODEL, inputTokens: 10, outputTokens: 5 });
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(mockCreateManagedMeter).toHaveBeenCalledWith(EVAL_SCOPE.supabase, "org_1", {
      evalRunId: "run_1",
    });
    expect(record).toHaveBeenCalledWith({
      usage: { model: MODEL, inputTokens: 10, outputTokens: 5 },
      callKind: "agent",
    });
  });

  it("BYO happy path: never builds a meter, and ctx.record() is a no-op", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-byo" });

    const result = await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "judge",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, MODEL),
      execute: async (ctx) => {
        expect(ctx.source).toBe("byo");
        expect(ctx.meter).toBeUndefined();
        await ctx.record({ model: MODEL, inputTokens: 1, outputTokens: 1 }); // must not throw
        return "byo-ok";
      },
    });

    expect(result).toBe("byo-ok");
    expect(mockCreateManagedMeter).not.toHaveBeenCalled();
    // The client is constructed from the RESOLVED provider (#485), which for a registry model
    // is exactly the registry's model→provider answer.
    expect(mockCreateProvider).toHaveBeenCalledWith("anthropic", { apiKey: "sk-byo" });
  });

  it("resolveKeyForModel honors an explicit provider (#485): no Anthropic misroute for a live model", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-openai-byo" });

    await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "reflect",
      // A live-listed model the registry doesn't know: providerForModel would say "anthropic",
      // but the run's stored reflect_provider says OpenAI.
      resolveKey: () =>
        resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, "gpt-5.3-preview", "openai"),
      execute: async () => "ok",
    });

    // The Team's OPENAI key row is resolved, and the OpenAI client is constructed.
    expect(mockResolveProviderKey).toHaveBeenCalledWith(
      EVAL_SCOPE.supabase,
      EVAL_SCOPE.orgId,
      "openai"
    );
    expect(mockCreateProvider).toHaveBeenCalledWith("openai", { apiKey: "sk-openai-byo" });
  });

  it("a live model whose BYO key vanished fails closed as unpriced-managed, naming the key requirement (#485)", async () => {
    // The key was deleted between run creation and execution: resolution falls through to the
    // managed key, the non-registry model has no price, and ADR-0008 fails closed BEFORE any
    // meter build or provider call.
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockPriceForModel.mockReturnValue(null);

    const execute = vi.fn();
    const thrown = await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "reflect",
      resolveKey: () =>
        resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, "gpt-5.3-preview", "openai"),
      execute,
    }).catch((e) => e);

    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).type).toBe("EvalRunTerminal");
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    // The terminal copy names the provider-key requirement, with the provider's display name.
    expect((thrown as ApplicationFailure).message).toContain("needs your own OpenAI API key");
    expect(execute).not.toHaveBeenCalled();
    expect(mockCreateManagedMeter).not.toHaveBeenCalled();
  });
});

describe("meteredCall — catch classification", () => {
  it("BYO provider rejection: logs provider_key.byo_failed and rethrows the ORIGINAL error unchanged", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-byo" });
    const rejection = new ProviderHttpError("anthropic", 401, '{"error":"bad key"}');

    const thrown = await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "agent",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, "claude-haiku-4-5-20251001"),
      execute: async () => {
        throw rejection;
      },
    }).catch((e) => e);

    // A BYO rejection is attributed but NOT converted to terminal — it must retry as a plain
    // provider error, never treated as a platform/billing fault.
    expect(thrown).toBe(rejection);
    expect(log.warn).toHaveBeenCalledWith(
      "Customer BYO provider key was rejected by the provider",
      expect.objectContaining({
        event: "provider_key.byo_failed",
        provider: "anthropic",
        org_id: "org_1",
        run_id: "run_1",
        status: 401,
      })
    );
    // Never logs key material.
    const call = vi
      .mocked(log.warn)
      .mock.calls.find((c) => (c[1] as { event?: string })?.event === "provider_key.byo_failed")!;
    expect(JSON.stringify(call[1])).not.toContain("sk-byo");
  });

  it("managed provider rejection: does NOT log provider_key.byo_failed", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockCreateManagedMeter.mockResolvedValue(meter());
    const rejection = new ProviderHttpError("anthropic", 401, '{"error":"bad key"}');

    await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "agent",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, MODEL),
      execute: async () => {
        throw rejection;
      },
    }).catch(() => {});

    expect(log.warn).not.toHaveBeenCalled();
  });

  it("BYO 404 model-not-found: converts to a nonRetryable modelUnavailable terminal, not a key blame (#488)", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-openai-byo" });
    // A live-listed model the provider retired between run creation and execution: the provider
    // 404s the id. That's OUR catalog drift, not the customer's key failing.
    const rejection = new ProviderHttpError("openai", 404, '{"error":{"message":"model not found"}}');

    const thrown = await meteredCall({
      scope: OPT_SCOPE,
      callKind: "reflect",
      resolveKey: () =>
        resolveKeyForModel(OPT_SCOPE.supabase, OPT_SCOPE.orgId, "gpt-5.3-preview", "openai"),
      execute: async () => {
        throw rejection;
      },
    }).catch((e) => e);

    // Fail fast (nonRetryable) with a comprehensible reason, on its own marker so GEPA's loop
    // re-throws it to failRun rather than retrying the doomed id...
    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).type).toBe("MODEL_UNAVAILABLE");
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    expect((thrown as ApplicationFailure).message).toContain("no longer available from OpenAI");
    // ...and it is NEVER attributed to the customer's key — a 404 is a model problem, not a key one.
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("BYO 400 unknown-model: also converts to the modelUnavailable terminal (some providers 400 an unknown id)", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-byo" });
    const rejection = new ProviderHttpError("mistral", 400, '{"message":"invalid model"}');

    const thrown = await meteredCall({
      scope: OPT_SCOPE,
      callKind: "reflect",
      resolveKey: () =>
        resolveKeyForModel(OPT_SCOPE.supabase, OPT_SCOPE.orgId, "mistral-future", "mistral"),
      execute: async () => {
        throw rejection;
      },
    }).catch((e) => e);

    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).type).toBe("MODEL_UNAVAILABLE");
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("eval folds a model-not-found into its single EvalRunTerminal marker", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-byo" });
    const rejection = new ProviderHttpError("anthropic", 404, "model not found");

    const thrown = await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "judge",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, MODEL),
      execute: async () => {
        throw rejection;
      },
    }).catch((e) => e);

    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).type).toBe("EvalRunTerminal");
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
  });

  it("BYO 5xx provider blip: also not attributed to the key (only 401/403/429 are)", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-byo" });
    const rejection = new ProviderHttpError("anthropic", 503, "service unavailable");

    const thrown = await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "judge",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, MODEL),
      execute: async () => {
        throw rejection;
      },
    }).catch((e) => e);

    expect(thrown).toBe(rejection);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("BYO 429 quota exhaustion: IS attributed to the key (a genuine key-quota rejection)", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-byo" });
    const rejection = new ProviderHttpError("openai", 429, "rate limit exceeded");

    await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "judge",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, "gpt-5", "openai"),
      execute: async () => {
        throw rejection;
      },
    }).catch(() => {});

    expect(log.warn).toHaveBeenCalledWith(
      "Customer BYO provider key was rejected by the provider",
      expect.objectContaining({ event: "provider_key.byo_failed", status: 429 })
    );
  });

  it("a managed-spend cap breach from meter.record() in execute is converted to the scope's billingBlocked terminal", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockCreateManagedMeter.mockResolvedValue(meter());

    const thrown = await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "judge",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, MODEL),
      execute: async () => {
        throw new ManagedSpendCapExceeded(10, 12);
      },
    }).catch((e) => e);

    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).type).toBe("EvalRunTerminal");
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
  });

  it("a payment-blocked meter-creation failure is converted to terminal too", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockCreateManagedMeter.mockRejectedValue(new ManagedPaymentBlockedError());

    const thrown = await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "judge",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, MODEL),
      execute: vi.fn(),
    }).catch((e) => e);

    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).type).toBe("EvalRunTerminal");
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
  });

  it("an unpriced-model error surfaced mid-execute converts to terminal like the upfront guard", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    mockCreateManagedMeter.mockResolvedValue(meter());

    const thrown = await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "judge",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, MODEL),
      execute: async () => {
        throw new UnpricedManagedCallError("anthropic", "some-model");
      },
    }).catch((e) => e);

    expect(thrown).toBeInstanceOf(ApplicationFailure);
    expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
  });

  it("a non-billing, non-provider error (e.g. a DB failure) rethrows unchanged", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-byo" });
    const dbError = new Error("upsert failed: timeout");

    const thrown = await meteredCall({
      scope: EVAL_SCOPE,
      callKind: "judge",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, MODEL),
      execute: async () => {
        throw dbError;
      },
    }).catch((e) => e);

    expect(thrown).toBe(dbError);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("resolveMeteredCall + runMeteredCall — the split used for a cached per-run resolution", () => {
  it("resolves once and lets a cached context be reused across many runMeteredCall executions", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "managed", key: "managed-key" });
    const record = vi.fn().mockResolvedValue(undefined);
    mockCreateManagedMeter.mockResolvedValue(meter(record));

    const ctx = await resolveMeteredCall({
      scope: EVAL_SCOPE,
      callKind: "agent",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, MODEL),
    });
    expect(mockCreateManagedMeter).toHaveBeenCalledTimes(1);

    await runMeteredCall(EVAL_SCOPE, ctx, async (c) => c.record({ model: MODEL, inputTokens: 1, outputTokens: 1 }));
    await runMeteredCall(EVAL_SCOPE, ctx, async (c) => c.record({ model: MODEL, inputTokens: 2, outputTokens: 2 }));

    // The expensive resolve/guard/meter-build ran once; only record() ran per call.
    expect(mockCreateManagedMeter).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("runMeteredCall still classifies a per-call failure using the cached context", async () => {
    mockResolveProviderKey.mockResolvedValue({ source: "byo", key: "sk-byo" });
    const ctx = await resolveMeteredCall({
      scope: EVAL_SCOPE,
      callKind: "agent",
      resolveKey: () => resolveKeyForModel(EVAL_SCOPE.supabase, EVAL_SCOPE.orgId, MODEL),
    });
    const rejection = new ProviderHttpError("anthropic", 403, "forbidden");

    const thrown = await runMeteredCall(EVAL_SCOPE, ctx, async () => {
      throw rejection;
    }).catch((e) => e);

    expect(thrown).toBe(rejection);
    expect(log.warn).toHaveBeenCalledWith(
      "Customer BYO provider key was rejected by the provider",
      expect.objectContaining({ event: "provider_key.byo_failed", status: 403 })
    );
  });
});
