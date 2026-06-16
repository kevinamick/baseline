/**
 * Pre-run managed-spend dollar estimate (#185, ADR-0008 Meter 2). PURE and
 * client-safe (no `server-only`, no DB) — shared by the run dialog (client) and
 * the pre-run gate (server) so the number shown and the number reserved can't
 * drift.
 *
 * Managed cost can only be metered from ACTUAL token counts after each call, so
 * this is an estimate: the per-model `typical*Tokens` assumption × the judge-call
 * count (rows × criteria), priced at the model's unit rates, plus the plan markup.
 * The real charge is always the metered actuals — the UI labels this "~".
 */
import { PLANS, type PlanSlug } from "@/lib/billing/plans";
import { priceForModel } from "@/lib/llm/model-prices";
import type { LlmProvider } from "@/lib/llm/providers";

/**
 * Estimated managed spend in dollars for an eval run, or null when no managed
 * estimate applies: the plan has no markup (Free/BYO-only), the model is unpriced
 * (a managed run would fail closed anyway), or there are no judge calls yet.
 */
export function estimateManagedSpendUsd(
  plan: PlanSlug,
  provider: LlmProvider,
  model: string,
  rowCount: number,
  criteriaCount: number,
): number | null {
  const markupPct = PLANS[plan].managedMarkupPct;
  if (markupPct == null) return null; // Free / BYO-only: tokens are the customer's.

  const price = priceForModel(provider, model);
  if (!price) return null; // unpriced model — no estimate (run fails closed).

  const calls = rowCount * criteriaCount;
  if (calls <= 0) return null;

  const perCallUsd =
    price.typicalInputTokens * price.inputUsdPerToken +
    price.typicalOutputTokens * price.outputUsdPerToken;

  return calls * perCallUsd * (1 + markupPct / 100);
}
