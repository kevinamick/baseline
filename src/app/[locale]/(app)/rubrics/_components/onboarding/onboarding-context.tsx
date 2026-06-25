"use client";

import { createContext, useContext, useMemo } from "react";
import {
  activeStep,
  satisfiedCount,
  RUBRIC_ONBOARDING_STEPS,
  type CoachMarkTarget,
  type OnboardingData,
  type OnboardingStep,
} from "./steps";

interface OnboardingValue {
  /** Live signals the steps derive from — lets the card recompute per-step state. */
  data: OnboardingData;
  /** Steps shown in the card; empty when the tutorial is hidden. */
  steps: OnboardingStep[];
  /** The first unsatisfied step, or null when the tutorial is complete/hidden. */
  active: OnboardingStep | null;
  /** Satisfied step count (the "N" in "N/N"). */
  completed: number;
  /** Total step count (the denominator). */
  total: number;
}

const OnboardingContext = createContext<OnboardingValue | null>(null);

/**
 * Seeds the guided first-run tutorial from live data. The tutorial is gated to
 * writers — Readonly Members can't create rubrics, so they never see it; when
 * `canWrite` is false the value collapses to an empty, inactive tutorial. All
 * progress is derived here from `data`; nothing is persisted.
 */
export function OnboardingProvider({
  data,
  canWrite,
  children,
}: {
  data: OnboardingData;
  canWrite: boolean;
  children: React.ReactNode;
}) {
  const value = useMemo<OnboardingValue>(() => {
    if (!canWrite) {
      return { data, steps: [], active: null, completed: 0, total: 0 };
    }
    const steps = RUBRIC_ONBOARDING_STEPS;
    return {
      data,
      steps,
      active: activeStep(steps, data),
      completed: satisfiedCount(steps, data),
      total: steps.length,
    };
  }, [canWrite, data]);

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

/** Read the tutorial state (null when no provider, e.g. isolated tests). */
export function useOnboarding(): OnboardingValue | null {
  return useContext(OnboardingContext);
}

/** Whether the active step's coach-mark anchors to `target`. */
export function useCoachMarkActive(target: CoachMarkTarget): boolean {
  return useContext(OnboardingContext)?.active?.target === target;
}
