import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// vi.hoisted: referenced inside the hoisted vi.mock factory below.
const {
  mockFrom,
  mockSelect,
  mockUpdate,
  mockEq,
  mockIs,
  mockMaybeSingle,
  mockLogError,
  updateResultBox,
} = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockSelect: vi.fn(),
  mockUpdate: vi.fn(),
  mockEq: vi.fn(),
  mockIs: vi.fn(),
  mockMaybeSingle: vi.fn(),
  mockLogError: vi.fn(),
  updateResultBox: { current: { data: [{ id: "redemption-1" }] as unknown, error: null as unknown } },
}));

// Chainable supabaseAdmin stub. The lookup chain terminates in
// `.maybeSingle()` (a real resolved value, queued per-test); the consume
// chain terminates in `.select("id")` with nothing further chained, so the
// chain object itself must be a thenable resolving to `updateResultBox` —
// same idiom as invitations/__tests__/pending.test.ts.
vi.mock("@/lib/supabase/admin", () => {
  const chain: Record<string, unknown> = {};
  chain.select = (...args: unknown[]) => {
    mockSelect(...args);
    return chain;
  };
  chain.update = (...args: unknown[]) => {
    mockUpdate(...args);
    return chain;
  };
  chain.eq = (...args: unknown[]) => {
    mockEq(...args);
    return chain;
  };
  chain.is = (...args: unknown[]) => {
    mockIs(...args);
    return chain;
  };
  chain.maybeSingle = () => mockMaybeSingle();
  chain.then = (resolve: (v: unknown) => void) => resolve(updateResultBox.current);
  return {
    supabaseAdmin: {
      from: (...args: unknown[]) => {
        mockFrom(...args);
        return chain;
      },
    },
  };
});
vi.mock("@/lib/logging/server", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: mockLogError },
}));

import { evaluateAndConsumeAccessCodeBenefit } from "../checkout-benefit";

beforeEach(() => {
  vi.clearAllMocks();
  updateResultBox.current = { data: [{ id: "redemption-1" }], error: null };
});

describe("evaluateAndConsumeAccessCodeBenefit", () => {
  it("returns no benefit when there is no unconsumed redemption bound to the org", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const result = await evaluateAndConsumeAccessCodeBenefit("org-1", "builder");

    expect(result).toEqual({ trialPeriodDays: null });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("applies the trial when the code has no plan restriction", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: { trial_days: 14, plan_slug: null },
      },
      error: null,
    });

    const result = await evaluateAndConsumeAccessCodeBenefit("org-1", "builder");

    expect(result).toEqual({ trialPeriodDays: 14 });
    expect(mockUpdate).toHaveBeenCalledWith({
      benefit_consumed_at: expect.any(String),
    });
    expect(mockEq).toHaveBeenCalledWith("id", "redemption-1");
    expect(mockIs).toHaveBeenCalledWith("benefit_consumed_at", null);
  });

  it("applies the trial when the code's plan restriction matches the chosen plan", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: { trial_days: 30, plan_slug: "builder" },
      },
      error: null,
    });

    const result = await evaluateAndConsumeAccessCodeBenefit("org-1", "builder");
    expect(result).toEqual({ trialPeriodDays: 30 });
  });

  it("handles the embed relation returned as an array (one-to-many shape)", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: [{ trial_days: 7, plan_slug: null }],
      },
      error: null,
    });

    const result = await evaluateAndConsumeAccessCodeBenefit("org-1", "builder");
    expect(result).toEqual({ trialPeriodDays: 7 });
  });

  it("does not apply the trial on a plan-restriction mismatch, but still consumes the redemption", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: { trial_days: 14, plan_slug: "scale" },
      },
      error: null,
    });

    const result = await evaluateAndConsumeAccessCodeBenefit("org-1", "builder");

    expect(result).toEqual({ trialPeriodDays: null });
    // Consumed regardless of the mismatch — no second evaluation ever sees it.
    expect(mockUpdate).toHaveBeenCalledWith({
      benefit_consumed_at: expect.any(String),
    });
  });

  it("returns no benefit when it loses the race to a concurrent checkout (consume matched 0 rows)", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: { trial_days: 14, plan_slug: null },
      },
      error: null,
    });
    updateResultBox.current = { data: [], error: null };

    const result = await evaluateAndConsumeAccessCodeBenefit("org-1", "builder");
    expect(result).toEqual({ trialPeriodDays: null });
  });

  it("fails closed and logs when the initial lookup errors", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "db down" },
    });

    const result = await evaluateAndConsumeAccessCodeBenefit("org-1", "builder");

    expect(result).toEqual({ trialPeriodDays: null });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith(
      "access code benefit lookup failed",
      expect.objectContaining({
        event: "access_code.benefit_lookup_failed",
        org_id: "org-1",
      })
    );
  });

  it("fails closed and logs when the consume update errors", async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: "redemption-1",
        access_codes: { trial_days: 14, plan_slug: null },
      },
      error: null,
    });
    updateResultBox.current = { data: null, error: { message: "boom" } };

    const result = await evaluateAndConsumeAccessCodeBenefit("org-1", "builder");

    expect(result).toEqual({ trialPeriodDays: null });
    expect(mockLogError).toHaveBeenCalledWith(
      "access code benefit consume failed",
      expect.objectContaining({
        event: "access_code.benefit_consume_failed",
        org_id: "org-1",
      })
    );
  });
});
