import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ManagedMeter,
  ManagedSpendCapExceeded,
  ManagedPaymentBlockedError,
  UnpricedManagedCallError,
  createManagedMeter,
} from "./managed-meter.js";
import { MODEL_PRICES, priceForModel } from "./model-prices.js";
import { ANTHROPIC_MODELS } from "./models.js";

const HAIKU = "claude-haiku-4-5-20251001";

// Every selectable Anthropic model must be priced. The eval/optimization workers gate managed
// target models with isAnthropicModel(); if a model is added to ANTHROPIC_MODELS but not priced,
// the "unpriced managed model" fail-closed check would become the only guard against a
// valid-but-unpriceable managed call. Keep the two lists in lockstep (#292).
describe("Anthropic model pricing parity", () => {
  it("prices every model in ANTHROPIC_MODELS", () => {
    for (const model of ANTHROPIC_MODELS) {
      expect(priceForModel("anthropic", model), `unpriced model: ${model}`).toBeTruthy();
    }
  });
});

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

  it("records a Managed Agent's target-model rollout under call_kind 'agent' (#291)", async () => {
    const meter = meterWith(rpc);
    await meter.record({
      usage: { inputTokens: 1000, outputTokens: 200, model: HAIKU },
      callKind: "agent",
    });
    expect(rpc).toHaveBeenCalledWith(
      "accrue_managed_spend",
      expect.objectContaining({ p_call_kind: "agent", p_model: HAIKU }),
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

  it("throws when the accrue_managed_spend RPC itself errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    const meter = meterWith(rpc);
    await expect(
      meter.record({
        usage: { inputTokens: 10, outputTokens: 5, model: HAIKU },
        callKind: "judge",
      }),
    ).rejects.toThrow("accrue_managed_spend failed: connection reset");
  });

  it("assertPriced throws for an unpriced model (pre-flight, before any call)", () => {
    const meter = meterWith(rpc);
    expect(() => meter.assertPriced("anthropic", HAIKU)).not.toThrow();
    // OpenAI/Google are priced now (#204); an unknown model on any provider still fails closed.
    expect(() => meter.assertPriced("openai", "gpt-5")).not.toThrow();
    expect(() => meter.assertPriced("openai", "gpt-nonexistent")).toThrow(UnpricedManagedCallError);
  });

  it("meters an optimization run (RunRef.optRunId) with p_opt_run_id set and p_eval_run_id null", async () => {
    const supabase = { rpc } as never;
    const meter = new ManagedMeter(supabase, {
      orgId: "org_1",
      run: { optRunId: "opt_1" },
      markupPct: 40,
      capUsd: 10,
    });
    await meter.record({
      usage: { inputTokens: 10, outputTokens: 5, model: HAIKU },
      callKind: "reflect",
    });
    expect(rpc).toHaveBeenCalledWith(
      "accrue_managed_spend",
      expect.objectContaining({ p_eval_run_id: null, p_opt_run_id: "opt_1" }),
    );
  });

  it("defaults accrued spend to 0 when the RPC reports no running total", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const meter = meterWith(rpc, 10);
    await expect(
      meter.record({
        usage: { inputTokens: 10, outputTokens: 5, model: HAIKU },
        callKind: "judge",
      }),
    ).resolves.toBeUndefined(); // 0 accrued never reaches the $10 cap
  });
});

describe("createManagedMeter (#185)", () => {
  function dbWith(reserveRow: unknown) {
    const maybeSingle = vi.fn().mockResolvedValue({ data: reserveRow, error: null });
    const builder: Record<string, unknown> = { maybeSingle };
    for (const k of ["select", "eq"]) builder[k] = () => builder;
    return { from: () => builder } as never;
  }

  // Per-table results, in call order (customers first, then managed_spend_ledger) — used by the
  // tests below that need the two reads to diverge (unlike dbWith's single shared row).
  function dbSequence(results: { data: unknown; error: { message: string } | null }[]) {
    const calls: string[] = [];
    return {
      from: (table: string) => {
        calls.push(table);
        const i = calls.length - 1;
        const builder: Record<string, unknown> = {
          maybeSingle: () => Promise.resolve(results[i] ?? { data: null, error: null }),
        };
        for (const k of ["select", "eq"]) builder[k] = () => builder;
        return builder;
      },
    } as never;
  }

  it("builds a meter from the run's reservation snapshot", async () => {
    const db = dbWith({ markup_pct: 40, cap_usd: 25 });
    const meter = await createManagedMeter(db, "org_1", { evalRunId: "run_1" });
    expect(meter).toBeInstanceOf(ManagedMeter);
  });

  it("builds a meter for an optimization run (RunRef.optRunId), keyed on opt_run_id", async () => {
    const db = dbWith({ markup_pct: 40, cap_usd: 25 });
    const meter = await createManagedMeter(db, "org_1", { optRunId: "opt_1" });
    expect(meter).toBeInstanceOf(ManagedMeter);
  });

  it("throws when the customers (payment-state) read fails", async () => {
    const db = dbSequence([{ data: null, error: { message: "customers read blew up" } }]);
    await expect(createManagedMeter(db, "org_1", { evalRunId: "run_1" })).rejects.toThrow(
      "Failed to read managed payment state: customers read blew up",
    );
  });

  it("throws when the managed_spend_ledger (reservation) read fails", async () => {
    const db = dbSequence([
      { data: null, error: null }, // customers: no payment block
      { data: null, error: { message: "ledger read blew up" } },
    ]);
    await expect(createManagedMeter(db, "org_1", { evalRunId: "run_1" })).rejects.toThrow(
      "Failed to read managed reservation: ledger read blew up",
    );
  });

  it("returns null when there's no reservation (a BYO run, never metered)", async () => {
    const db = dbWith(null);
    const meter = await createManagedMeter(db, "org_1", { evalRunId: "run_1" });
    expect(meter).toBeNull();
  });

  it("fails closed mid-flight when a managed-token payment is failing (#186)", async () => {
    // The customers read (first) reports the fail-closed flag set → refuse the
    // run before any managed call, even one already queued before the block.
    const db = dbWith({
      managed_payment_failed_at: "2026-06-15T00:00:00Z",
      markup_pct: 40,
      cap_usd: 25,
    });
    await expect(
      createManagedMeter(db, "org_1", { evalRunId: "run_1" }),
    ).rejects.toBeInstanceOf(ManagedPaymentBlockedError);
  });
});
