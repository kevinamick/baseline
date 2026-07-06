import { describe, it, expect } from "vitest";
import {
  NewOptimizationConnectionSchema,
  CreateOptimizationRunSchema,
  InstancesSourceSchema,
  MAX_OPTIMIZATION_INSTANCES,
  DATASET_SNAPSHOT_MAX_WINDOW_MINUTES,
} from "@/lib/validation/schemas";

function validConnection(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    name: "Inline agent",
    endpoint: "https://api.example.com/agent",
    authHeader: null,
    authValue: null,
    requestTemplate: '{"input":"{{user_input}}","system":"{{prompt:system}}","style":"{{prompt:style}}"}',
    responsePath: "output",
    optimizablePrompts: [
      { name: "system", seed: "Answer helpfully." },
      { name: "style", seed: "Be concise." },
    ],
    ...overrides,
  };
}

describe("NewOptimizationConnectionSchema", () => {
  it("accepts an agent connection whose declared Modules and template references match", () => {
    expect(NewOptimizationConnectionSchema.safeParse(validConnection()).success).toBe(true);
  });

  it("requires at least one Module", () => {
    const res = NewOptimizationConnectionSchema.safeParse(validConnection({ optimizablePrompts: [] }));
    expect(res.success).toBe(false);
  });

  it("rejects a declared Module not referenced in the template", () => {
    // 'style' is declared but the template only references {{prompt:system}}.
    const res = NewOptimizationConnectionSchema.safeParse(
      validConnection({ requestTemplate: '{"input":"{{user_input}}","system":"{{prompt:system}}"}' })
    );
    expect(res.success).toBe(false);
    expect(res.success ? "" : res.error.issues[0].message).toContain('Declared Module "style"');
  });

  it("rejects a template reference with no matching declared Module", () => {
    const res = NewOptimizationConnectionSchema.safeParse(
      validConnection({
        optimizablePrompts: [{ name: "system", seed: "Answer." }],
        requestTemplate: '{"system":"{{prompt:system}}","extra":"{{prompt:ghost}}"}',
      })
    );
    expect(res.success).toBe(false);
    expect(res.success ? "" : res.error.issues[0].message).toContain("{{prompt:ghost}}");
  });

  it("rejects a Module referenced only in a JSON object key (renderer never substitutes keys)", () => {
    // {{prompt:system}} appears only as a KEY; renderTemplate would never inject the prompt,
    // so the cross-check must treat `system` as unreferenced rather than silently passing.
    const res = NewOptimizationConnectionSchema.safeParse(
      validConnection({
        optimizablePrompts: [{ name: "system", seed: "Answer." }],
        requestTemplate: '{"{{prompt:system}}":"literal","input":"{{user_input}}"}',
      })
    );
    expect(res.success).toBe(false);
    expect(res.success ? "" : res.error.issues[0].message).toContain('Declared Module "system"');
  });

  it("rejects duplicate Module names", () => {
    const res = NewOptimizationConnectionSchema.safeParse(
      validConnection({
        optimizablePrompts: [
          { name: "system", seed: "a" },
          { name: "system", seed: "b" },
        ],
        requestTemplate: '{"system":"{{prompt:system}}"}',
      })
    );
    expect(res.success).toBe(false);
  });

  it("requires an auth header name when an auth value is set", () => {
    const res = NewOptimizationConnectionSchema.safeParse(
      validConnection({ authValue: "Bearer sk-123", authHeader: null })
    );
    expect(res.success).toBe(false);
  });
});

describe("CreateOptimizationRunSchema connection xor", () => {
  const base = {
    rubricId: "11111111-1111-4111-8111-111111111111",
    instancesSource: {
      type: "inline" as const,
      instances: [{ userInput: "Q", expectedOutput: null, retrievalContext: null }],
    },
    budgetRollouts: 30,
  };

  it("accepts exactly an existing connectionId", () => {
    const res = CreateOptimizationRunSchema.safeParse({
      ...base,
      connectionId: "22222222-2222-4222-8222-222222222222",
    });
    expect(res.success).toBe(true);
  });

  it("accepts exactly a newConnection", () => {
    const res = CreateOptimizationRunSchema.safeParse({ ...base, newConnection: validConnection() });
    expect(res.success).toBe(true);
  });

  it("rejects when neither is provided", () => {
    const res = CreateOptimizationRunSchema.safeParse(base);
    expect(res.success).toBe(false);
  });

  it("rejects when both are provided", () => {
    const res = CreateOptimizationRunSchema.safeParse({
      ...base,
      connectionId: "22222222-2222-4222-8222-222222222222",
      newConnection: validConnection(),
    });
    expect(res.success).toBe(false);
  });
});

// The instances-source seam (#82): a further source (e.g. seeding from an existing Eval Run,
// #83) is just another discriminated-union member alongside these two.
describe("InstancesSourceSchema", () => {
  const DATASET_CONNECTION_ID = "33333333-3333-4333-8333-333333333333";

  it("accepts an inline source with at least one instance", () => {
    const res = InstancesSourceSchema.safeParse({
      type: "inline",
      instances: [{ userInput: "Q", expectedOutput: null, retrievalContext: null }],
    });
    expect(res.success).toBe(true);
  });

  it("rejects an inline source with zero instances", () => {
    const res = InstancesSourceSchema.safeParse({ type: "inline", instances: [] });
    expect(res.success).toBe(false);
  });

  it("rejects an inline source over the instance cap", () => {
    const instances = Array.from({ length: MAX_OPTIMIZATION_INSTANCES + 1 }, (_, i) => ({
      userInput: `Q${i}`,
      expectedOutput: null,
      retrievalContext: null,
    }));
    const res = InstancesSourceSchema.safeParse({ type: "inline", instances });
    expect(res.success).toBe(false);
  });

  it("accepts a dataset_snapshot source with a connectionId and windowMinutes", () => {
    const res = InstancesSourceSchema.safeParse({
      type: "dataset_snapshot",
      connectionId: DATASET_CONNECTION_ID,
      windowMinutes: 1440,
    });
    expect(res.success).toBe(true);
  });

  it("rejects a dataset_snapshot source with an invalid connectionId", () => {
    const res = InstancesSourceSchema.safeParse({
      type: "dataset_snapshot",
      connectionId: "not-a-uuid",
      windowMinutes: 1440,
    });
    expect(res.success).toBe(false);
  });

  it("rejects a dataset_snapshot source with a window past the ceiling", () => {
    const res = InstancesSourceSchema.safeParse({
      type: "dataset_snapshot",
      connectionId: DATASET_CONNECTION_ID,
      windowMinutes: DATASET_SNAPSHOT_MAX_WINDOW_MINUTES + 1,
    });
    expect(res.success).toBe(false);
  });
});
