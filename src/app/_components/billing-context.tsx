"use client";

import { createContext, useContext, useMemo } from "react";
import type { PlanSlug } from "@/lib/billing/plans";

/**
 * Client billing context (#185). Carries the per-request, server-resolved bits
 * of billing state that client surfaces need, seeded once by the page that owns
 * the subtree — so consumers (e.g. the run dialog) read it via a hook instead of
 * being prop-drilled through every layer between page and leaf.
 *
 * Carries the team's effective plan (#352 — tier-based limits in the rubric
 * editor), the plan a managed-key Team's pre-run dollar estimate is priced
 * against (null for BYO/Free — no estimate), and the retention window.
 */
interface BillingContextValue {
  /** The team's effective plan slug (#352). Defaults to "free". */
  plan: PlanSlug;
  /** Plan to price the run dialog's managed-spend estimate; null = none shown. */
  managedEstimatePlan: PlanSlug | null;
  /** The plan's Retention Window in days (#187) — the run-history boundary label. */
  retentionDays: number;
}

// Defaults degrade gracefully for a consumer rendered outside a provider (a test,
// or a surface that doesn't seed billing): free plan, no managed estimate, and
// the Free-floor retention window (14 days) — the always-available baseline.
const BillingContext = createContext<BillingContextValue>({
  plan: "free",
  managedEstimatePlan: null,
  retentionDays: 14,
});

export function BillingProvider({
  plan = "free",
  managedEstimatePlan,
  retentionDays = 14,
  children,
}: {
  plan?: PlanSlug;
  managedEstimatePlan: PlanSlug | null;
  retentionDays?: number;
  children: React.ReactNode;
}) {
  const value = useMemo(
    () => ({ plan, managedEstimatePlan, retentionDays }),
    [plan, managedEstimatePlan, retentionDays],
  );
  return <BillingContext.Provider value={value}>{children}</BillingContext.Provider>;
}

/** The team's effective plan slug (#352). */
export function usePlan(): PlanSlug {
  return useContext(BillingContext).plan;
}

/** The plan the run dialog prices its managed-spend estimate against, or null. */
export function useManagedEstimatePlan(): PlanSlug | null {
  return useContext(BillingContext).managedEstimatePlan;
}

/** The plan's Retention Window in days — for the run-history boundary label (#187). */
export function useRetentionDays(): number {
  return useContext(BillingContext).retentionDays;
}
