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
  /** Per-point overage price; null = no overage (hard stop). */
  evalPointOverageUsd: number | null;
  /** Per-run overage price; null = no overage. */
  optimizationRunOverageUsd: number | null;
  retentionDays: number;
  /** Managed-key markup as a percentage; null = BYO-key only (no managed). */
  managedMarkupPct: number | null;
  /**
   * Default Managed Spend Cap (ADR-0008); null = not applicable (BYO-only).
   * A tunable pricing knob — the value, not the existence of the field.
   */
  defaultManagedSpendCapUsd: number | null;
  /** Env var holding this plan's Stripe price id; null = no checkout (Free). */
  priceEnvVar: string | null;
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
    evalPointOverageUsd: null,
    optimizationRunOverageUsd: null,
    retentionDays: 14,
    managedMarkupPct: null,
    defaultManagedSpendCapUsd: null,
    priceEnvVar: null,
  },
  builder: {
    slug: "builder",
    name: "Builder",
    audience: "Professional Developers",
    monthlyPriceUsd: 49,
    seatLimit: null,
    includedEvalPoints: 100_000,
    includedOptimizationRuns: 15,
    evalPointOverageUsd: 0.0005,
    optimizationRunOverageUsd: 1.5,
    retentionDays: 90,
    managedMarkupPct: 40,
    defaultManagedSpendCapUsd: 25,
    priceEnvVar: "STRIPE_PRICE_BUILDER",
  },
  scale: {
    slug: "scale",
    name: "Scale",
    audience: "Rapidly Growing AI Teams",
    monthlyPriceUsd: 199,
    seatLimit: null,
    includedEvalPoints: 500_000,
    includedOptimizationRuns: 75,
    evalPointOverageUsd: 0.0003,
    optimizationRunOverageUsd: 1.0,
    retentionDays: 1_095,
    managedMarkupPct: 30,
    defaultManagedSpendCapUsd: 100,
    priceEnvVar: "STRIPE_PRICE_SCALE",
  },
};

/** Ordered for display (cheapest → most capable). */
export const ORDERED_PLANS: PlanDefinition[] = PLAN_SLUGS.map((s) => PLANS[s]);

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
