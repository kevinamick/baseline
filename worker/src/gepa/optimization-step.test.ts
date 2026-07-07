import { describe, it, expect, vi } from "vitest";
import {
  startOptimizationStep,
  advanceOptimizationStep,
  driveOptimizationStep,
  type OptimizationStepActiveEffect,
  type OptimizationStepEvent,
  type OptimizationStepPolicy,
  type OptimizationStepState,
  type RolloutOutcome,
} from "./optimization-step.js";
import { accepts } from "./pareto.js";

function outcome(overallScore: number, overrides: Partial<RolloutOutcome> = {}): RolloutOutcome {
  return { overallScore, instanceScores: { 0: overallScore }, instancesRun: 5, ...overrides };
}

// Mirrors the Reflective (GEPA) workflow's policy: roll out the parent first, gate the child on
// strictly beating it, and follow an accepted child with a full-set eval.
const gepaPolicy: OptimizationStepPolicy = {
  rolloutParent: true,
  hasFollowUp: true,
  accepts: (parentScore, childScore) => accepts(childScore, parentScore as number),
};

// Mirrors the Simple Mode workflow's policy: no parent rollout, no gate, no follow-up.
const simplePolicy: OptimizationStepPolicy = {
  rolloutParent: false,
  hasFollowUp: false,
  accepts: () => true,
};

const affordable = { budgetAllowsFollowUp: true };
const unaffordable = { budgetAllowsFollowUp: false };

describe("startOptimizationStep", () => {
  it("GEPA policy: starts by rolling out the parent", () => {
    expect(startOptimizationStep(gepaPolicy)).toEqual({
      state: { kind: "rolling-out-parent" },
      effect: { kind: "call-rollout-parent" },
    });
  });

  it("Simple policy: skips the parent rollout and starts by proposing", () => {
    expect(startOptimizationStep(simplePolicy)).toEqual({
      state: { kind: "proposing", parent: null },
      effect: { kind: "call-propose" },
    });
  });
});

describe("advanceOptimizationStep — GEPA policy", () => {
  it("walks rollout-parent -> propose -> rollout-child -> accept -> rollout-follow-up -> done", () => {
    let { state, effect } = startOptimizationStep(gepaPolicy);
    expect(effect).toEqual({ kind: "call-rollout-parent" });

    const parentOutcome = outcome(0.5);
    ({ state, effect } = advanceOptimizationStep(
      state,
      { kind: "parent-scored", outcome: parentOutcome },
      gepaPolicy,
      affordable
    ));
    expect(state).toEqual({ kind: "proposing", parent: parentOutcome });
    expect(effect).toEqual({ kind: "call-propose" });

    ({ state, effect } = advanceOptimizationStep(
      state,
      { kind: "child-proposed" },
      gepaPolicy,
      affordable
    ));
    expect(state).toEqual({ kind: "rolling-out-child", parent: parentOutcome });
    expect(effect).toEqual({ kind: "call-rollout-child" });

    const childOutcome = outcome(0.7);
    ({ state, effect } = advanceOptimizationStep(
      state,
      { kind: "child-scored", outcome: childOutcome },
      gepaPolicy,
      affordable
    ));
    expect(state).toEqual({ kind: "rolling-out-follow-up", child: childOutcome });
    expect(effect).toEqual({ kind: "call-rollout-follow-up" });

    const followUpOutcome = outcome(0.9, { instanceScores: { 0: 0.9, 1: 0.4 } });
    ({ state, effect } = advanceOptimizationStep(
      state,
      { kind: "follow-up-scored", outcome: followUpOutcome },
      gepaPolicy,
      affordable
    ));
    expect(state).toEqual({
      kind: "done",
      result: {
        accepted: true,
        child: childOutcome,
        followUp: followUpOutcome,
        budgetExhausted: false,
      },
    });
    expect(effect).toEqual({ kind: "none" });
  });

  it("rejects a child that does not beat the parent — no follow-up rollout", () => {
    let { state } = startOptimizationStep(gepaPolicy);
    const parentOutcome = outcome(0.5);
    ({ state } = advanceOptimizationStep(
      state,
      { kind: "parent-scored", outcome: parentOutcome },
      gepaPolicy,
      affordable
    ));
    ({ state } = advanceOptimizationStep(state, { kind: "child-proposed" }, gepaPolicy, affordable));

    const childOutcome = outcome(0.3); // worse than the parent's 0.5
    const { state: doneState, effect } = advanceOptimizationStep(
      state,
      { kind: "child-scored", outcome: childOutcome },
      gepaPolicy,
      affordable
    );
    expect(doneState).toEqual({
      kind: "done",
      result: { accepted: false, child: childOutcome, followUp: null, budgetExhausted: false },
    });
    expect(effect).toEqual({ kind: "none" });
  });

  it("a tie does not accept (strictly-beats gate)", () => {
    let { state } = startOptimizationStep(gepaPolicy);
    const parentOutcome = outcome(0.5);
    ({ state } = advanceOptimizationStep(
      state,
      { kind: "parent-scored", outcome: parentOutcome },
      gepaPolicy,
      affordable
    ));
    ({ state } = advanceOptimizationStep(state, { kind: "child-proposed" }, gepaPolicy, affordable));

    const { state: doneState } = advanceOptimizationStep(
      state,
      { kind: "child-scored", outcome: outcome(0.5) },
      gepaPolicy,
      affordable
    );
    expect(doneState.kind).toBe("done");
    if (doneState.kind === "done") expect(doneState.result.accepted).toBe(false);
  });

  it("stops without a follow-up rollout when the child is accepted but the budget can't afford it", () => {
    let { state } = startOptimizationStep(gepaPolicy);
    const parentOutcome = outcome(0.5);
    ({ state } = advanceOptimizationStep(
      state,
      { kind: "parent-scored", outcome: parentOutcome },
      gepaPolicy,
      affordable
    ));
    ({ state } = advanceOptimizationStep(state, { kind: "child-proposed" }, gepaPolicy, affordable));

    const childOutcome = outcome(0.9);
    const { state: doneState, effect } = advanceOptimizationStep(
      state,
      { kind: "child-scored", outcome: childOutcome },
      gepaPolicy,
      unaffordable
    );
    expect(doneState).toEqual({
      kind: "done",
      result: { accepted: true, child: childOutcome, followUp: null, budgetExhausted: true },
    });
    expect(effect).toEqual({ kind: "none" });
  });
});

describe("advanceOptimizationStep — Simple policy", () => {
  it("walks propose -> rollout-child -> done, no accept gate and no follow-up", () => {
    let { state, effect } = startOptimizationStep(simplePolicy);
    ({ state, effect } = advanceOptimizationStep(
      state,
      { kind: "child-proposed" },
      simplePolicy,
      unaffordable // ignored: policy.hasFollowUp is false
    ));
    expect(state).toEqual({ kind: "rolling-out-child", parent: null });
    expect(effect).toEqual({ kind: "call-rollout-child" });

    const childOutcome = outcome(0.1); // "worse" than nothing — Simple has no gate to reject it
    ({ state, effect } = advanceOptimizationStep(
      state,
      { kind: "child-scored", outcome: childOutcome },
      simplePolicy,
      unaffordable
    ));
    expect(state).toEqual({
      kind: "done",
      result: { accepted: true, child: childOutcome, followUp: null, budgetExhausted: false },
    });
    expect(effect).toEqual({ kind: "none" });
  });
});

describe("driveOptimizationStep", () => {
  it("GEPA policy: executes rollout-parent, propose, rollout-child, rollout-follow-up in order and returns the result", async () => {
    const parentOutcome = outcome(0.5);
    const childOutcome = outcome(0.7);
    const followUpOutcome = outcome(0.9, { instanceScores: { 0: 0.9, 1: 0.4 } });
    const calls: string[] = [];

    const execute = vi.fn(async (effect: OptimizationStepActiveEffect): Promise<OptimizationStepEvent> => {
      calls.push(effect.kind);
      switch (effect.kind) {
        case "call-rollout-parent":
          return { kind: "parent-scored", outcome: parentOutcome };
        case "call-propose":
          return { kind: "child-proposed" };
        case "call-rollout-child":
          return { kind: "child-scored", outcome: childOutcome };
        case "call-rollout-follow-up":
          return { kind: "follow-up-scored", outcome: followUpOutcome };
      }
    });

    const result = await driveOptimizationStep(gepaPolicy, execute, () => true);

    expect(calls).toEqual([
      "call-rollout-parent",
      "call-propose",
      "call-rollout-child",
      "call-rollout-follow-up",
    ]);
    expect(result).toEqual({
      accepted: true,
      child: childOutcome,
      followUp: followUpOutcome,
      budgetExhausted: false,
    });
  });

  it("GEPA policy: stops after rollout-child (no follow-up call) when the child is rejected", async () => {
    const parentOutcome = outcome(0.5);
    const childOutcome = outcome(0.3);
    const calls: string[] = [];

    const execute = vi.fn(async (effect: OptimizationStepActiveEffect): Promise<OptimizationStepEvent> => {
      calls.push(effect.kind);
      switch (effect.kind) {
        case "call-rollout-parent":
          return { kind: "parent-scored", outcome: parentOutcome };
        case "call-propose":
          return { kind: "child-proposed" };
        case "call-rollout-child":
          return { kind: "child-scored", outcome: childOutcome };
        default:
          throw new Error(`unexpected effect ${effect.kind}`);
      }
    });

    const result = await driveOptimizationStep(gepaPolicy, execute, () => true);

    expect(calls).toEqual(["call-rollout-parent", "call-propose", "call-rollout-child"]);
    expect(result.accepted).toBe(false);
    expect(result.followUp).toBeNull();
  });

  it("GEPA policy: re-reads the budget thunk fresh, so an accept that's unaffordable stops without a follow-up call", async () => {
    const parentOutcome = outcome(0.5);
    const childOutcome = outcome(0.9);
    const calls: string[] = [];
    let budgetAllows = true;

    const execute = vi.fn(async (effect: OptimizationStepActiveEffect): Promise<OptimizationStepEvent> => {
      calls.push(effect.kind);
      switch (effect.kind) {
        case "call-rollout-parent":
          budgetAllows = false; // spending the parent+child rollouts exhausts the budget
          return { kind: "parent-scored", outcome: parentOutcome };
        case "call-propose":
          return { kind: "child-proposed" };
        case "call-rollout-child":
          return { kind: "child-scored", outcome: childOutcome };
        default:
          throw new Error(`unexpected effect ${effect.kind}`);
      }
    });

    const result = await driveOptimizationStep(gepaPolicy, execute, () => budgetAllows);

    expect(calls).toEqual(["call-rollout-parent", "call-propose", "call-rollout-child"]);
    expect(result).toEqual({
      accepted: true,
      child: childOutcome,
      followUp: null,
      budgetExhausted: true,
    });
  });

  it("Simple policy: executes propose then rollout-child only, no gate and no follow-up", async () => {
    const childOutcome = outcome(0.4);
    const calls: string[] = [];

    const execute = vi.fn(async (effect: OptimizationStepActiveEffect): Promise<OptimizationStepEvent> => {
      calls.push(effect.kind);
      switch (effect.kind) {
        case "call-propose":
          return { kind: "child-proposed" };
        case "call-rollout-child":
          return { kind: "child-scored", outcome: childOutcome };
        default:
          throw new Error(`unexpected effect ${effect.kind}`);
      }
    });

    const result = await driveOptimizationStep(simplePolicy, execute, () => false);

    expect(calls).toEqual(["call-propose", "call-rollout-child"]);
    expect(result).toEqual({
      accepted: true,
      child: childOutcome,
      followUp: null,
      budgetExhausted: false,
    });
  });
});

describe("advanceOptimizationStep — invalid transitions", () => {
  it("rejects an event that can't occur in the given state", () => {
    expect(() =>
      advanceOptimizationStep(
        { kind: "rolling-out-parent" },
        { kind: "child-proposed" },
        gepaPolicy,
        affordable
      )
    ).toThrow(/invalid in state "rolling-out-parent"/);
  });

  it("rejects any event fed to the terminal 'done' state", () => {
    const done: OptimizationStepState = {
      kind: "done",
      result: { accepted: false, child: outcome(0.5), followUp: null, budgetExhausted: false },
    };
    expect(() =>
      advanceOptimizationStep(done, { kind: "child-proposed" }, gepaPolicy, affordable)
    ).toThrow();
  });
});
