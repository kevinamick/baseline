/**
 * Guided first-run tutorial — step model and derivation.
 *
 * Onboarding progress is PURELY derived from live data: there is no persisted
 * onboarding state, no flag, and no replay. A step is satisfied by reading real
 * data; the active step is the first unsatisfied one. Steps are modelled as a
 * list so later slices (the eval step, the free-plan key step) slot in without
 * reworking the card count or active-step logic.
 */

/** The live signals onboarding steps derive from. Grows as steps are added. */
export interface OnboardingData {
  /** Number of rubrics the Team owns. */
  rubricCount: number;
  /**
   * Number of Eval Runs the Team has ever created (any status). The eval step
   * ticks on run *created*, not completed, so a slow or failed first run still
   * advances the tutorial.
   */
  runCount: number;
  /**
   * Number of BYO provider keys the Team has stored. The free-plan key step is
   * satisfied at >= 1 — derived from live data, never persisted.
   */
  providerKeyCount: number;
}

/**
 * Stable target identifiers a coach-mark can pin to. `providerKey` is the one
 * step with no on-page control to anchor to (keys live at /settings/team), so
 * its coach-mark pins to the progress card's own CTA.
 */
export type CoachMarkTarget = "providerKey" | "rubricCreate" | "runEval";

export interface OnboardingStep {
  /** Stable id; also the i18n key under `Rubrics.onboarding.steps`. */
  id: string;
  /** Which on-page control this step's coach-mark anchors to. */
  target: CoachMarkTarget;
  /** Derived: true once the step's goal is met (no persisted state). */
  isSatisfied: (data: OnboardingData) => boolean;
}

/**
 * The rubric-surface onboarding steps, in order. For a paid Team this is the
 * full tutorial: create a rubric, then run the first eval against it. A free
 * Team leads with the provider-key step (see `onboardingStepsForPlan`).
 */
export const RUBRIC_ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "createRubric",
    target: "rubricCreate",
    isSatisfied: (data) => data.rubricCount >= 1,
  },
  {
    id: "runEval",
    target: "runEval",
    isSatisfied: (data) => data.runCount >= 1,
  },
];

/**
 * The free-plan lead step: add a BYO provider key. Free Teams have no managed
 * fallback, so they must add their own LLM key before they can run any eval —
 * this comes first, ahead of creating a rubric.
 */
export const ADD_PROVIDER_KEY_STEP: OnboardingStep = {
  id: "addProviderKey",
  target: "providerKey",
  isSatisfied: (data) => data.providerKeyCount >= 1,
};

/**
 * The ordered step list for the Team's plan. Free Teams lead with the
 * provider-key step (key → rubric → eval); paid Teams have the managed-key
 * fallback and skip it (rubric → eval). Ordering is what makes the rubric/eval
 * coach-marks wait until a key exists on a free plan.
 */
export function onboardingStepsForPlan(isFreePlan: boolean): OnboardingStep[] {
  return isFreePlan
    ? [ADD_PROVIDER_KEY_STEP, ...RUBRIC_ONBOARDING_STEPS]
    : RUBRIC_ONBOARDING_STEPS;
}

/** The first unsatisfied step, or null when every step is satisfied. */
export function activeStep(
  steps: OnboardingStep[],
  data: OnboardingData,
): OnboardingStep | null {
  return steps.find((step) => !step.isSatisfied(data)) ?? null;
}

/** How many steps are satisfied — the numerator of the "N/N" count. */
export function satisfiedCount(
  steps: OnboardingStep[],
  data: OnboardingData,
): number {
  return steps.filter((step) => step.isSatisfied(data)).length;
}
