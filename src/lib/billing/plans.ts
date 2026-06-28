/**
 * Plan definitions — the single source of truth for the pricing model (issue
 * #137, ADR-0008). Every quota, limit, price, and markup lives here once; the
 * pricing page, checkout, and (later) quota enforcement all derive from this
 * list rather than duplicating numbers. Plan *definitions* are code, not a DB
 * table or Stripe metadata, so a pricing change is a reviewed PR.
 *
 * Stripe price ids are NOT hard-coded here — they differ per environment
 * (test/live) and are resolved from env at call time (priceIdForPlan), so a
 * client can never substitute one.
 */

/** Single source of the plan variant set; types derive from it. */
export const PLAN_SLUGS = ["free", "builder", "scale"] as const;
export type PlanSlug = (typeof PLAN_SLUGS)[number];

/** The paid, self-serve plans (Enterprise is sales-led, not a slug here). */
export const PAID_PLAN_SLUGS = ["builder", "scale"] as const;
export type PaidPlanSlug = (typeof PAID_PLAN_SLUGS)[number];

export interface PlanDefinition {
  slug: PlanSlug;
  name: string;
  audience: string;
  monthlyPriceUsd: number;
  /** Max Contributors+Members; null = unlimited. */
  seatLimit: number | null;
  includedEvalPoints: number;
  includedOptimizationRuns: number;
  /**
   * Max `budget_rollouts` a single Optimization Run may request (ADR-0008's
   * per-run orchestration-cost ceiling), enforced server-side. 0 = no runs.
   */
  maxBudgetRollouts: number;
  /**
   * Per-point overage price; null = no overage (hard stop). This is the single
   * platform-overage rate: Optimization Run overage past the included run-count
   * is metered in Eval Points too (ADR-0016), so there is no separate per-run
   * dollar rate.
   */
  evalPointOverageUsd: number | null;
  retentionDays: number;
  /** Managed-key markup as a percentage; null = BYO-key only (no managed). */
  managedMarkupPct: number | null;
  /**
   * Default Managed Spend Cap (ADR-0008); null = not applicable (BYO-only).
   * A tunable pricing knob — the value, not the existence of the field.
   */
  defaultManagedSpendCapUsd: number | null;
  /**
   * Threshold-billing trigger (#186, ADR-0008): when un-invoiced accrued managed
   * spend crosses this many dollars, an invoice is issued IMMEDIATELY rather than
   * at month-end — billing starts early so a decline surfaces (and fails managed
   * runs closed) well before a Team can sit at a full unpaid cap. Deliberately
   * below the Managed Spend Cap and INDEPENDENT of any cap override. NB the hard
   * ceiling on un-invoiced exposure is still the cap (accrual continues between
   * the once-a-minute sweeps); the threshold front-loads *when* billing begins,
   * it is not itself the exposure bound. null = BYO-only (no managed).
   */
  managedInvoiceThresholdUsd: number | null;
  /** Env var holding this plan's Stripe price id; null = no checkout (Free). */
  priceEnvVar: string | null;
  /**
   * Max criteria per rubric (#352). Free plans are capped at 3; paid plans
   * allow more. Enforced client-side in the rubric editor.
   */
  rubricCriteriaLimit: number;
  /**
   * Max scoring steps per criterion (#352). Free plans are capped at 3;
   * paid plans allow more.
   */
  rubricStepsPerCriterionLimit: number;
}

export const PLANS: Record<PlanSlug, PlanDefinition> = {
  free: {
    slug: "free",
    name: "Free",
    audience: "Individual Experimenters",
    monthlyPriceUsd: 0,
    seatLimit: 1,
    includedEvalPoints: 5_000,
    includedOptimizationRuns: 0,
    maxBudgetRollouts: 0,
    evalPointOverageUsd: null,
    retentionDays: 14,
   managedMarkupPct: null,
   defaultManagedSpendCapUsd: null,
   managedInvoiceThresholdUsd: null,
   priceEnvVar: null,
   rubricCriteriaLimit: 3,
   rubricStepsPerCriterionLimit: 3,
 },
 builder: {
   slug: "builder",
    name: "Builder",
    audience: "Professional Developers",
    monthlyPriceUsd: 49,
    seatLimit: null,
    includedEvalPoints: 100_000,
    includedOptimizationRuns: 15,
    maxBudgetRollouts: 200,
    evalPointOverageUsd: 0.0005,
    retentionDays: 90,
   managedMarkupPct: 40,
   defaultManagedSpendCapUsd: 25,
   managedInvoiceThresholdUsd: 10,
   priceEnvVar: "STRIPE_PRICE_BUILDER",
   rubricCriteriaLimit: 10,
   rubricStepsPerCriterionLimit: 10,
 },
 scale: {
   slug: "scale",
    name: "Scale",
    audience: "Rapidly Growing AI Teams",
    monthlyPriceUsd: 199,
    seatLimit: null,
    includedEvalPoints: 500_000,
    includedOptimizationRuns: 75,
    // Caps a single run's worst-case point cost (ADR-0016) at ~6% of the 500k
    // point allotment, bringing Scale's worst-case season in line with Builder.
    maxBudgetRollouts: 400,
    evalPointOverageUsd: 0.0003,
    retentionDays: 1_095,
    managedMarkupPct: 30,
    defaultManagedSpendCapUsd: 100,
    managedInvoiceThresholdUsd: 25,
   priceEnvVar: "STRIPE_PRICE_SCALE",
   rubricCriteriaLimit: 15,
   rubricStepsPerCriterionLimit: 15,
 },
};

/** Ordered for display (cheapest → most capable). */
export const ORDERED_PLANS: PlanDefinition[] = PLAN_SLUGS.map((s) => PLANS[s]);

/**
 * Trust escalation for the Managed Spend Cap (#188, ADR-0008's fourth managed-token
 * guardrail). A Team's *trust ceiling* — the most it may self-raise its cap to —
 * starts at the plan default and rises with successful (paid, undisputed) invoice
 * history. This schedule is the pricing knob: a count of clean invoices unlocks a
 * multiple of the plan's default cap. A brand-new Team sits at the first tier
 * (×1 = the plan default), so it can never self-raise above the default until it
 * has built a payment record — by ANY sequence of UI/API calls, because the only
 * write path (setManagedSpendCap) checks this ceiling.
 *
 * Expressed as a multiple of the plan default (not absolute dollars) so each plan
 * scales from its own base (Builder $25, Scale $100) off one shared schedule. Free
 * has no managed spend (no default), so it has no ceiling.
 *
 * Tiers are evaluated highest-unlocked-wins; keep them sorted ascending by
 * minPaidInvoices. The top tier is the absolute self-serve ceiling (Scale ×8 =
 * $800); a Team needing more is a sales conversation, not a form.
 */
export interface TrustTier {
  /** Minimum count of paid, un-reversed invoices that unlocks this tier. */
  minPaidInvoices: number;
  /** Trust ceiling at this tier, as a multiple of the plan's default cap. */
  capMultiplier: number;
}

export const TRUST_ESCALATION_SCHEDULE: readonly TrustTier[] = [
  { minPaidInvoices: 0, capMultiplier: 1 }, // new Team: ceiling = plan default
  { minPaidInvoices: 2, capMultiplier: 2 },
  { minPaidInvoices: 4, capMultiplier: 4 },
  { minPaidInvoices: 8, capMultiplier: 8 },
] as const;

/** The tier in force for a given paid-invoice count (highest unlocked). */
function trustTierFor(paidInvoiceCount: number): TrustTier {
  let tier = TRUST_ESCALATION_SCHEDULE[0];
  for (const t of TRUST_ESCALATION_SCHEDULE) {
    if (paidInvoiceCount >= t.minPaidInvoices) tier = t;
  }
  return tier;
}

/**
 * The Team's trust ceiling in dollars: the plan default cap times the multiplier
 * its paid-invoice history has unlocked. Null when the plan has no managed spend
 * (Free) — there is no cap to raise. Pure (no I/O) so it's unit-tested directly.
 */
export function trustCeilingUsd(
  plan: PlanSlug,
  paidInvoiceCount: number,
): number | null {
  const base = PLANS[plan].defaultManagedSpendCapUsd;
  if (base == null) return null;
  return base * trustTierFor(paidInvoiceCount).capMultiplier;
}

/**
 * The next tier a Team would unlock by paying more invoices — its invoice count
 * and the ceiling it would reach — or null if already at the top tier or the plan
 * has no managed spend. Powers the "pay N more to raise your ceiling to $X" copy.
 */
export function nextTrustTier(
  plan: PlanSlug,
  paidInvoiceCount: number,
): { atPaidInvoices: number; ceilingUsd: number } | null {
  const base = PLANS[plan].defaultManagedSpendCapUsd;
  if (base == null) return null;
  const next = TRUST_ESCALATION_SCHEDULE.find(
    (t) => t.minPaidInvoices > paidInvoiceCount,
  );
  return next
    ? { atPaidInvoices: next.minPaidInvoices, ceilingUsd: base * next.capMultiplier }
    : null;
}

export function isPlanSlug(value: unknown): value is PlanSlug {
  return (
    typeof value === "string" && (PLAN_SLUGS as readonly string[]).includes(value)
  );
}

export function isPaidPlanSlug(value: unknown): value is PaidPlanSlug {
  return (
    typeof value === "string" &&
    (PAID_PLAN_SLUGS as readonly string[]).includes(value)
  );
}

/**
 * The Stripe price id for a paid plan, resolved from env server-side. Throws on
 * a non-paid slug or a missing env var — a misconfiguration must fail loudly,
 * never silently fall back to the wrong price.
 */
export function priceIdForPlan(slug: PaidPlanSlug): string {
  const envVar = PLANS[slug].priceEnvVar;
  if (!envVar) throw new Error(`Plan ${slug} has no Stripe price`);
  const priceId = process.env[envVar];
  if (!priceId) throw new Error(`Missing env ${envVar} for plan ${slug}`);
  return priceId;
}

/**
 * Reverse lookup: which plan a mirrored Stripe price id belongs to, or null if
 * it matches none (e.g. a retired price). Reads the same env mapping.
 */
export function planForPriceId(priceId: string | null): PlanSlug | null {
  if (!priceId) return null;
  for (const slug of PAID_PLAN_SLUGS) {
    if (process.env[PLANS[slug].priceEnvVar!] === priceId) return slug;
  }
  return null;
}
