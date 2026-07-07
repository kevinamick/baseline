import { describe, it, expect } from "vitest";
import { NewConnectionSchema, NewOptimizationConnectionSchema } from "@/lib/validation/schemas";

// The "Paste a prompt" Managed Agent (#293) is a discriminated-union member on both the generic
// connection-create schema (used by the eval/schedule pickers, #294) and the optimization-run's
// inline-connection schema. It carries only a prompt + target model — no endpoint/template/auth.
const validManaged = {
  type: "managed_agent" as const,
  targetModel: "claude-haiku-4-5-20251001" as const,
  prompt: "You are a helpful support agent.",
};

describe("managed_agent connection schema", () => {
  it("accepts a valid managed agent on both union entry points", () => {
    expect(NewConnectionSchema.safeParse(validManaged).success).toBe(true);
    expect(NewOptimizationConnectionSchema.safeParse(validManaged).success).toBe(true);
  });

  it("rejects a target model outside the managed registry", () => {
    const bad = { ...validManaged, targetModel: "gpt-4o" };
    expect(NewConnectionSchema.safeParse(bad).success).toBe(false);
    expect(NewOptimizationConnectionSchema.safeParse(bad).success).toBe(false);
  });

  it("requires a non-empty prompt", () => {
    expect(NewConnectionSchema.safeParse({ ...validManaged, prompt: "   " }).success).toBe(false);
  });

  it("does not require any external-agent field (endpoint/template/auth)", () => {
    // None of the agent-only fields are present, yet the managed branch parses — the agent-only
    // cross-checks (prompt-ref, auth-header) must not run on the managed discriminant.
    const result = NewOptimizationConnectionSchema.safeParse(validManaged);
    expect(result.success).toBe(true);
  });
});
