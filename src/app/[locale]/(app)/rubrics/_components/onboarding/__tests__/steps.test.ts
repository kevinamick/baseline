import { describe, it, expect } from "vitest";
import {
  RUBRIC_ONBOARDING_STEPS,
  activeStep,
  satisfiedCount,
  type OnboardingStep,
} from "../steps";

describe("onboarding steps — derived progress", () => {
  it("the create-rubric step is unsatisfied when the Team has no rubrics", () => {
    const step = RUBRIC_ONBOARDING_STEPS[0];
    expect(step.id).toBe("createRubric");
    expect(step.target).toBe("rubricCreate");
    expect(step.isSatisfied({ rubricCount: 0 })).toBe(false);
  });

  it("the create-rubric step is satisfied once the Team has >= 1 rubric", () => {
    const step = RUBRIC_ONBOARDING_STEPS[0];
    expect(step.isSatisfied({ rubricCount: 1 })).toBe(true);
    expect(step.isSatisfied({ rubricCount: 5 })).toBe(true);
  });

  it("active step is the first unsatisfied step", () => {
    expect(activeStep(RUBRIC_ONBOARDING_STEPS, { rubricCount: 0 })?.id).toBe(
      "createRubric",
    );
  });

  it("there is no active step once every step is satisfied", () => {
    expect(activeStep(RUBRIC_ONBOARDING_STEPS, { rubricCount: 1 })).toBeNull();
  });

  it("counts satisfied steps for the N/N display", () => {
    expect(satisfiedCount(RUBRIC_ONBOARDING_STEPS, { rubricCount: 0 })).toBe(0);
    expect(satisfiedCount(RUBRIC_ONBOARDING_STEPS, { rubricCount: 2 })).toBe(1);
  });

  it("resolves the first unsatisfied step when several exist (extensibility)", () => {
    // Models a future multi-step slice without changing production data.
    const steps: OnboardingStep[] = [
      { id: "a", target: "rubricCreate", isSatisfied: () => true },
      { id: "b", target: "rubricCreate", isSatisfied: () => false },
      { id: "c", target: "rubricCreate", isSatisfied: () => false },
    ];
    expect(activeStep(steps, { rubricCount: 0 })?.id).toBe("b");
    expect(satisfiedCount(steps, { rubricCount: 0 })).toBe(1);
  });
});
