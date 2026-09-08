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
   * Number of runtime-ready providers with a usable key (Vault or the operator's
   * env var). The key step is satisfied at >= 1 — derived from live data, never
   * persisted.
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

/** The rubric-surface steps that follow the key step: create a rubric, then run an eval. */
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
 * The lead step: add a provider key. There is no managed fallback, so a key must
 * exist before any eval can run — this comes first, ahead of creating a rubric.
 */
export const ADD_PROVIDER_KEY_STEP: OnboardingStep = {
  id: "addProviderKey",
  target: "providerKey",
  isSatisfied: (data) => data.providerKeyCount >= 1,
};

/**
 * The ordered tutorial (ADR-0020): add a provider key (Vault or env), create a
 * rubric, run an eval. There is no managed fallback, so the key step always leads;
 * ordering is what makes the rubric/eval coach-marks wait until a key exists.
 */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  ADD_PROVIDER_KEY_STEP,
  ...RUBRIC_ONBOARDING_STEPS,
];

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
