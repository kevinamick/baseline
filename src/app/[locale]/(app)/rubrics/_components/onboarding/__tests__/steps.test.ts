import { describe, it, expect } from "vitest";
import {
  ADD_PROVIDER_KEY_STEP,
  RUBRIC_ONBOARDING_STEPS,
  ONBOARDING_STEPS,
  activeStep,
  satisfiedCount,
  type OnboardingData,
  type OnboardingStep,
} from "../steps";

/** Base signals with every step unsatisfied; override per assertion. */
const EMPTY: OnboardingData = {
  rubricCount: 0,
  runCount: 0,
  providerKeyCount: 0,
};

describe("onboarding steps — derived progress", () => {
  it("the create-rubric step is unsatisfied when the Team has no rubrics", () => {
    const step = RUBRIC_ONBOARDING_STEPS[0];
    expect(step.id).toBe("createRubric");
    expect(step.target).toBe("rubricCreate");
    expect(step.isSatisfied(EMPTY)).toBe(false);
  });

  it("the create-rubric step is satisfied once the Team has >= 1 rubric", () => {
    const step = RUBRIC_ONBOARDING_STEPS[0];
    expect(step.isSatisfied({ ...EMPTY, rubricCount: 1 })).toBe(true);
    expect(step.isSatisfied({ ...EMPTY, rubricCount: 5 })).toBe(true);
  });

  it("the run-eval step is unsatisfied until the Team has an eval run", () => {
    const step = RUBRIC_ONBOARDING_STEPS[1];
    expect(step.id).toBe("runEval");
    expect(step.target).toBe("runEval");
    expect(step.isSatisfied({ ...EMPTY, rubricCount: 1 })).toBe(false);
  });

  it("the run-eval step ticks on run created (any status), not completion", () => {
    const step = RUBRIC_ONBOARDING_STEPS[1];
    // >= 1 run satisfies regardless of status — a slow or failed first run still
    // advances the tutorial, since the count is over all created runs.
    expect(step.isSatisfied({ ...EMPTY, rubricCount: 1, runCount: 1 })).toBe(true);
    expect(step.isSatisfied({ ...EMPTY, rubricCount: 1, runCount: 9 })).toBe(true);
  });

  it("active step is the first unsatisfied step (create before run)", () => {
    expect(activeStep(RUBRIC_ONBOARDING_STEPS, EMPTY)?.id).toBe("createRubric");
    expect(
      activeStep(RUBRIC_ONBOARDING_STEPS, { ...EMPTY, rubricCount: 1 })?.id,
    ).toBe("runEval");
  });

  it("there is no active step once every step is satisfied", () => {
    expect(
      activeStep(RUBRIC_ONBOARDING_STEPS, {
        ...EMPTY,
        rubricCount: 1,
        runCount: 1,
      }),
    ).toBeNull();
  });

  it("counts satisfied steps for the N/N display (paid Team: 2 steps)", () => {
    expect(RUBRIC_ONBOARDING_STEPS.length).toBe(2);
    expect(satisfiedCount(RUBRIC_ONBOARDING_STEPS, EMPTY)).toBe(0);
    expect(
      satisfiedCount(RUBRIC_ONBOARDING_STEPS, { ...EMPTY, rubricCount: 2 }),
    ).toBe(1);
    expect(
      satisfiedCount(RUBRIC_ONBOARDING_STEPS, {
        ...EMPTY,
        rubricCount: 2,
        runCount: 3,
      }),
    ).toBe(2);
  });

  it("resolves the first unsatisfied step when several exist (extensibility)", () => {
    // Models a future multi-step slice without changing production data.
    const steps: OnboardingStep[] = [
      { id: "a", target: "rubricCreate", isSatisfied: () => true },
      { id: "b", target: "rubricCreate", isSatisfied: () => false },
      { id: "c", target: "rubricCreate", isSatisfied: () => false },
    ];
    expect(activeStep(steps, EMPTY)?.id).toBe("b");
    expect(satisfiedCount(steps, EMPTY)).toBe(1);
  });
});

describe("onboarding steps — free-plan provider-key step (plan-aware)", () => {
  it("the key step is satisfied once the Team has >= 1 provider key", () => {
    expect(ADD_PROVIDER_KEY_STEP.id).toBe("addProviderKey");
    expect(ADD_PROVIDER_KEY_STEP.target).toBe("providerKey");
    expect(ADD_PROVIDER_KEY_STEP.isSatisfied(EMPTY)).toBe(false);
    expect(
      ADD_PROVIDER_KEY_STEP.isSatisfied({ ...EMPTY, providerKeyCount: 1 }),
    ).toBe(true);
  });

  it("leads with the key step, then rubric, then eval (3 steps)", () => {
    const steps = ONBOARDING_STEPS;
    expect(steps.map((s) => s.id)).toEqual([
      "addProviderKey",
      "createRubric",
      "runEval",
    ]);
    // The key step is first, so it's the active step and the count is 0/3.
    expect(activeStep(steps, EMPTY)?.id).toBe("addProviderKey");
    expect(satisfiedCount(steps, EMPTY)).toBe(0);
    expect(steps.length).toBe(3);
  });

  it("rubric/eval stay inactive until a key exists", () => {
    const steps = ONBOARDING_STEPS;
    // Even with a rubric already created, the active step is still the key step
    // — ordering makes the rubric/eval coach-marks wait until a key exists.
    expect(
      activeStep(steps, { ...EMPTY, rubricCount: 1, runCount: 0 })?.id,
    ).toBe("addProviderKey");
    // Once a key is added, the tutorial advances to the next unsatisfied step.
    expect(
      activeStep(steps, {
        ...EMPTY,
        providerKeyCount: 1,
        rubricCount: 0,
      })?.id,
    ).toBe("createRubric");
    expect(satisfiedCount(steps, { ...EMPTY, providerKeyCount: 1 })).toBe(1);
  });
});
