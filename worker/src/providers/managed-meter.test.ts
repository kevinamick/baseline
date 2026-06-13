import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ManagedMeter,
  ManagedSpendCapExceeded,
  UnpricedManagedCallError,
  createManagedMeter,
} from "./managed-meter.js";
import { MODEL_PRICES } from "./model-prices.js";

const HAIKU = "claude-haiku-4-5-20251001";

function meterWith(rpc: ReturnType<typeof vi.fn>, capUsd = 10, markupPct = 40) {
  const supabase = { rpc } as never;
  return new ManagedMeter(supabase, {
    orgId: "org_1",
    run: { evalRunId: "run_1" },
    markupPct,
    capUsd,
  });
}

describe("ManagedMeter (#185)", () => {
  let rpc: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    rpc = vi.fn().mockResolvedValue({ data: 1, error: null });
  });

  it("prices a call from token usage + markup and accrues it", async () => {
    const meter = meterWith(rpc);
    await meter.record({
      usage: { inputTokens: 1000, outputTokens: 200, model: HAIKU },
      callKind: "judge",
    });
    const price = MODEL_PRICES.anthropic[HAIKU];
    const expected =
      (1000 * price.inputUsdPerToken + 200 * price.outputUsdPerToken) * 1.4;
    expect(rpc).toHaveBeenCalledWith(
      "accrue_managed_spend",
      expect.objectContaining({
        p_provider: "anthropic",
        p_model: HAIKU,
        p_amount_usd: expect.closeTo(expected, 10),
        p_call_kind: "judge",
        p_eval_run_id: "run_1",
        p_opt_run_id: null,
      }),
    );
  });

  it("throws ManagedSpendCapExceeded once accrued reaches the cap", async () => {
    rpc.mockResolvedValue({ data: 10, error: null }); // running total hits the $10 cap
    const meter = meterWith(rpc, 10);
    await expect(
      meter.record({
        usage: { inputTokens: 10, outputTokens: 5, model: HAIKU },
        callKind: "judge",
      }),
    ).rejects.toBeInstanceOf(ManagedSpendCapExceeded);
  });

  it("does NOT throw while accrued stays under the cap", async () => {
    rpc.mockResolvedValue({ data: 9.99, error: null });
    const meter = meterWith(rpc, 10);
    await expect(
      meter.record({
        usage: { inputTokens: 10, outputTokens: 5, model: HAIKU },
        callKind: "judge",
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed on an unpriced model", async () => {
    const meter = meterWith(rpc);
    await expect(
      meter.record({
        usage: { inputTokens: 10, outputTokens: 5, model: "gpt-bogus" },
        callKind: "judge",
      }),
    ).rejects.toBeInstanceOf(UnpricedManagedCallError);
    expect(rpc).not.toHaveBeenCalled(); // nothing accrued for an unpriceable call
  });

  it("fails closed when a managed call reports no usage", async () => {
    const meter = meterWith(rpc);
    await expect(
      meter.record({ usage: undefined, callKind: "judge" }),
    ).rejects.toThrow(/no token usage/i);
  });

  it("assertPriced throws for an unpriced model (pre-flight, before any call)", () => {
    const meter = meterWith(rpc);
    expect(() => meter.assertPriced("anthropic", HAIKU)).not.toThrow();
    expect(() => meter.assertPriced("openai", "gpt-5")).toThrow(UnpricedManagedCallError);
  });
});

describe("createManagedMeter (#185)", () => {
  function dbWith(reserveRow: unknown) {
    const maybeSingle = vi.fn().mockResolvedValue({ data: reserveRow, error: null });
    const builder: Record<string, unknown> = { maybeSingle };
    for (const k of ["select", "eq"]) builder[k] = () => builder;
    return { from: () => builder } as never;
  }

  it("builds a meter from the run's reservation snapshot", async () => {
    const db = dbWith({ markup_pct: 40, cap_usd: 25 });
    const meter = await createManagedMeter(db, "org_1", { evalRunId: "run_1" });
    expect(meter).toBeInstanceOf(ManagedMeter);
  });

  it("returns null when there's no reservation (a BYO run, never metered)", async () => {
    const db = dbWith(null);
    const meter = await createManagedMeter(db, "org_1", { evalRunId: "run_1" });
    expect(meter).toBeNull();
  });
});
