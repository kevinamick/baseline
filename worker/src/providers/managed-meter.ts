import type { SupabaseClient } from "@supabase/supabase-js";
import { priceForModel } from "./model-prices.js";
import { providerForModel } from "./models.js";
import type { LlmProvider } from "./provider-list.js";
import type { TokenUsage } from "./llm.js";
import { log } from "../log.js";

// Managed-token gateway metering (#185, ADR-0008 Meter 2). A ManagedMeter is
// created only for runs resolved to a MANAGED key (paid Team, no BYO key) — BYO
// runs spend the customer's own tokens and are never metered (the worker passes
// no meter for them). The meter prices each call from the code-side price table,
// snapshots the unit prices + markup into an append-only accrual row, and stops
// the run the moment accrued spend reaches the Managed Spend Cap.

/** Thrown to terminate a run whose managed spend reached the cap (fail-closed). */
export class ManagedSpendCapExceeded extends Error {
  constructor(public readonly capUsd: number, public readonly accruedUsd: number) {
    super(
      `Managed spend cap of $${capUsd} reached ($${accruedUsd.toFixed(2)} accrued). ` +
        `Raise the cap on the Billing page or add your own provider key (Settings → Team).`,
    );
    this.name = "ManagedSpendCapExceeded";
  }
}

/** Thrown to refuse a managed run while a managed-token payment is failing (#186). */
export class ManagedPaymentBlockedError extends Error {
  constructor() {
    super(
      "Managed runs are paused: a managed-token payment failed. Update your card " +
        "(Settings → Billing) — runs resume automatically once it's paid — or add " +
        "your own provider key (Settings → Team).",
    );
    this.name = "ManagedPaymentBlockedError";
  }
}

/** Thrown when a managed call cannot be priced — no unpriced managed call may bill. */
export class UnpricedManagedCallError extends Error {
  constructor(provider: string, model: string) {
    super(
      `No managed price for ${provider}/${model}. This model can't run on a managed ` +
        `key — add your own provider key (Settings → Team) or use a supported model.`,
    );
    this.name = "UnpricedManagedCallError";
  }
}

type RunRef = { evalRunId: string } | { optRunId: string };

export class ManagedMeter {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly opts: {
      orgId: string;
      run: RunRef;
      markupPct: number;
      capUsd: number;
    },
  ) {}

  /**
   * Pre-flight: assert the model is priced BEFORE any managed call is made, so an
   * unpriced model fails closed without ever burning a managed token (ADR-0008).
   */
  assertPriced(provider: LlmProvider, model: string): void {
    if (!priceForModel(provider, model)) {
      throw new UnpricedManagedCallError(provider, model);
    }
  }

  /**
   * Price one managed call from its token usage, write the append-only accrual
   * row (snapshotting the unit prices + markup), and stop the run if the accrued
   * total has reached the cap. Throws ManagedSpendCapExceeded between units. The
   * provider/model are taken from the usage the call reported, so callers
   * (evaluator) need not know which provider served the call.
   */
  async record(input: {
    usage: TokenUsage | undefined;
    callKind: "judge" | "reflect";
  }): Promise<void> {
    if (!input.usage) {
      // A managed call that reported no usage can't be priced — fail closed
      // rather than bill $0 and undercharge.
      throw new Error("Managed call reported no token usage — cannot meter (fail closed).");
    }
    const model = input.usage.model;
    const provider = providerForModel(model);
    const price = priceForModel(provider, model);
    if (!price) throw new UnpricedManagedCallError(provider, model);

    const { inputTokens, outputTokens } = input.usage;
    const rawUsd =
      inputTokens * price.inputUsdPerToken + outputTokens * price.outputUsdPerToken;
    const costUsd = rawUsd * (1 + this.opts.markupPct / 100);

    const runId =
      "evalRunId" in this.opts.run ? this.opts.run.evalRunId : this.opts.run.optRunId;
    const { data, error } = await this.supabase.rpc("accrue_managed_spend", {
      p_org_id: this.opts.orgId,
      p_amount_usd: costUsd,
      p_provider: provider,
      p_model: model,
      p_input_tokens: inputTokens,
      p_output_tokens: outputTokens,
      p_input_unit_usd: price.inputUsdPerToken,
      p_output_unit_usd: price.outputUsdPerToken,
      p_markup_pct: this.opts.markupPct,
      p_call_kind: input.callKind,
      p_eval_run_id: "evalRunId" in this.opts.run ? this.opts.run.evalRunId : null,
      p_opt_run_id: "optRunId" in this.opts.run ? this.opts.run.optRunId : null,
    });
    if (error) {
      throw new Error(`accrue_managed_spend failed: ${error.message}`);
    }

    const accruedUsd = Number(data ?? 0);
    log.info("Managed call metered", {
      event: "managed_spend.accrued",
      run_id: runId,
      provider,
      model,
      cost_usd: costUsd,
      accrued_usd: accruedUsd,
      cap_usd: this.opts.capUsd,
    });

    // Mid-run stop: once accrued spend reaches the cap, refuse further units.
    if (accruedUsd >= this.opts.capUsd) {
      throw new ManagedSpendCapExceeded(this.opts.capUsd, accruedUsd);
    }
  }
}

/**
 * Build a ManagedMeter from a run's managed reservation. The reserve row (written
 * by the app's pre-run reserve) snapshots the markup and the effective cap the
 * run was admitted under — model-independent, frozen for this run. Returns null
 * when there's no reservation (a BYO run, never metered).
 */
export async function createManagedMeter(
  supabase: SupabaseClient,
  orgId: string,
  run: RunRef,
): Promise<ManagedMeter | null> {
  const column = "evalRunId" in run ? "eval_run_id" : "opt_run_id";
  const runId = "evalRunId" in run ? run.evalRunId : run.optRunId;

  // Fail-closed at run start (#186): the meter is built when a managed run begins
  // (eval: once at start; optimization: re-checked per activity), so a managed run
  // that STARTS after a payment failure — including one queued before the block —
  // is refused before any managed token burns. (An eval run already mid-execution
  // when payment fails finishes; new and queued runs are stopped, which bounds
  // continued exposure.) BYO runs never reach here (the worker only builds a meter
  // for managed-key runs). Clears automatically when the invoice is paid.
  const { data: cust, error: custError } = await supabase
    .from("customers")
    .select("managed_payment_failed_at")
    .eq("org_id", orgId)
    .maybeSingle();
  if (custError) throw new Error(`Failed to read managed payment state: ${custError.message}`);
  if (cust?.managed_payment_failed_at != null) throw new ManagedPaymentBlockedError();

  const { data, error } = await supabase
    .from("managed_spend_ledger")
    .select("markup_pct, cap_usd")
    .eq("entry_type", "reserve")
    .eq(column, runId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read managed reservation: ${error.message}`);
  if (!data || data.markup_pct == null || data.cap_usd == null) return null;

  return new ManagedMeter(supabase, {
    orgId,
    run,
    markupPct: Number(data.markup_pct),
    capUsd: Number(data.cap_usd),
  });
}
