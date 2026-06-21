import { describe, it, expect } from "vitest";
import { RUBRIC_TEMPLATES } from "./rubric-templates";

describe("RUBRIC_TEMPLATES", () => {
  it("exports at least one template", () => {
    expect(RUBRIC_TEMPLATES.length).toBeGreaterThan(0);
  });

  it("every template has a unique id", () => {
    const ids = RUBRIC_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every template has a non-empty name, description, scenario, and expected outcome", () => {
    for (const template of RUBRIC_TEMPLATES) {
      expect(template.name.trim()).not.toBe("");
      expect(template.description.trim()).not.toBe("");
      expect(template.scenario_description.trim()).not.toBe("");
      expect(template.expected_outcome.trim()).not.toBe("");
    }
  });

  it("every template has a valid evaluation_mode", () => {
    const validModes = ["prompt_response", "conversational"];
    for (const template of RUBRIC_TEMPLATES) {
      expect(validModes).toContain(template.evaluation_mode);
    }
  });

  it("every template has at least one criterion", () => {
    for (const template of RUBRIC_TEMPLATES) {
      expect(template.criteria.length).toBeGreaterThan(0);
    }
  });

  it("every criterion has a name, weight in [0,1], and at least one step", () => {
    for (const template of RUBRIC_TEMPLATES) {
      for (const criterion of template.criteria) {
        expect(criterion.name.trim()).not.toBe("");
        expect(criterion.weight).toBeGreaterThan(0);
        expect(criterion.weight).toBeLessThanOrEqual(1);
        expect(criterion.steps.length).toBeGreaterThan(0);
        for (const step of criterion.steps) {
          expect(step.trim()).not.toBe("");
        }
      }
    }
  });

  it("criterion weights sum to 1.0 in every template", () => {
    for (const template of RUBRIC_TEMPLATES) {
      const total = template.criteria.reduce((sum, c) => sum + c.weight, 0);
      expect(Math.abs(total - 1.0)).toBeLessThan(0.001);
    }
  });

  it("includes Customer Support Standard template", () => {
    const template = RUBRIC_TEMPLATES.find(
      (t) => t.id === "customer-support-standard"
    );
    expect(template).toBeDefined();
    expect(template!.name).toBe("Customer Support Standard");
  });

  it("includes Sales Tone Verification template", () => {
    const template = RUBRIC_TEMPLATES.find(
      (t) => t.id === "sales-tone-verification"
    );
    expect(template).toBeDefined();
    expect(template!.name).toBe("Sales Tone Verification");
  });
});
