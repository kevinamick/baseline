import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("server-only", () => ({}));

const mockGetAuthContext = vi.fn();
const mockTrack = vi.fn();
vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

interface MockBuilder {
  _mirror: unknown;
  _memberCount: number;
  from: Mock;
  select: Mock;
  eq: Mock;
  maybeSingle: Mock;
  then: (resolve: (v: unknown) => void) => void;
}
const builder: MockBuilder = {
  _mirror: null,
  _memberCount: 1,
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
  then: (resolve) => resolve({ count: builder._memberCount }),
};
for (const m of ["from", "select", "eq"] as const) {
  builder[m].mockReturnValue(builder);
}
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: builder }));

const mockSubRetrieve = vi.fn();
const mockSubUpdate = vi.fn();
const mockSchedCreate = vi.fn();
const mockSchedUpdate = vi.fn();
const mockSchedRelease = vi.fn();
const mockSchedRetrieve = vi.fn();
vi.mock("@/lib/stripe", () => ({
  stripe: {
    subscriptions: { retrieve: mockSubRetrieve, update: mockSubUpdate },
    subscriptionSchedules: {
      create: mockSchedCreate,
      update: mockSchedUpdate,
      release: mockSchedRelease,
      retrieve: mockSchedRetrieve,
    },
  },
}));

function mirror(overrides: Record<string, unknown> = {}) {
  return {
    org_id: "org_abc",
    stripe_subscription_id: "sub_1",
    stripe_price_id: "price_builder_live",
    status: "active",
    current_period_end: "2026-07-01T00:00:00Z",
    cancel_at_period_end: false,
    stripe_schedule_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const m of ["from", "select", "eq"] as const) {
    builder[m].mockReturnValue(builder);
  }
  process.env.STRIPE_PRICE_BUILDER = "price_builder_live";
  process.env.STRIPE_PRICE_SCALE = "price_scale_live";
  mockGetAuthContext.mockResolvedValue({
    userId: "user_abc",
    orgId: "org_abc",
    role: "admin",
    canWrite: true,
  });
  builder.maybeSingle.mockImplementation(() =>
    Promise.resolve({ data: builder._mirror, error: null })
  );
  builder._mirror = mirror();
  builder._memberCount = 1;
  mockSubRetrieve.mockResolvedValue({
    id: "sub_1",
    items: { data: [{ id: "si_1" }] },
  });
  mockSubUpdate.mockResolvedValue({});
  mockSchedCreate.mockResolvedValue({
    id: "sched_new",
    phases: [{ start_date: 1_700_000_000, end_date: 1_702_592_000 }],
  });
  mockSchedUpdate.mockResolvedValue({});
  mockSchedRelease.mockResolvedValue({});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("upgradeToScale", () => {
  it("rejects non-contributors", async () => {
    mockGetAuthContext.mockResolvedValue({
      userId: "u",
      orgId: "org_abc",
      canWrite: false,
    });
    const { upgradeToScale } = await import("../billing-plan");
    expect(await upgradeToScale()).toEqual({
      error: "Only contributors can change the plan",
    });
    expect(mockSubUpdate).not.toHaveBeenCalled();
  });

  it("rejects teams without an active subscription", async () => {
    builder._mirror = mirror({ status: "canceled" });
    const { upgradeToScale } = await import("../billing-plan");
    expect(await upgradeToScale()).toEqual({
      error: "This team has no active subscription",
    });
  });

  it("applies immediately with proration and clears any scheduled cancel", async () => {
    const { upgradeToScale } = await import("../billing-plan");
    expect(await upgradeToScale()).toEqual({ ok: true });
    expect(mockSubUpdate).toHaveBeenCalledWith("sub_1", {
      items: [{ id: "si_1", price: "price_scale_live" }],
      // always_invoice: the quota delta lands immediately, so the prorated
      // charge must be collected immediately too.
      proration_behavior: "always_invoice",
      cancel_at_period_end: false,
    });
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ name: "billing.plan_upgraded" }),
      { userId: "user_abc" }
    );
  });

  it("releases a pending schedule before upgrading (upgrade supersedes)", async () => {
    builder._mirror = mirror({ stripe_schedule_id: "sched_1" });
    const { upgradeToScale } = await import("../billing-plan");
    expect(await upgradeToScale()).toEqual({ ok: true });
    expect(mockSchedRelease).toHaveBeenCalledWith("sched_1");
  });

  it("no-ops when already on Scale", async () => {
    builder._mirror = mirror({ stripe_price_id: "price_scale_live" });
    const { upgradeToScale } = await import("../billing-plan");
    expect(await upgradeToScale()).toEqual({ error: "This team is already on Scale" });
  });
});

describe("scheduleDowngradeToBuilder", () => {
  it("only applies to Scale teams", async () => {
    const { scheduleDowngradeToBuilder } = await import("../billing-plan");
    expect(await scheduleDowngradeToBuilder()).toEqual({
      error: "Only Scale teams can switch down to Builder",
    });
  });

  it("creates a two-phase schedule ending in Builder", async () => {
    builder._mirror = mirror({ stripe_price_id: "price_scale_live" });
    const { scheduleDowngradeToBuilder } = await import("../billing-plan");
    expect(await scheduleDowngradeToBuilder()).toEqual({ ok: true });
    expect(mockSchedCreate).toHaveBeenCalledWith({ from_subscription: "sub_1" });
    expect(mockSchedUpdate).toHaveBeenCalledWith("sched_new", {
      end_behavior: "release",
      phases: [
        {
          items: [{ price: "price_scale_live", quantity: 1 }],
          start_date: 1_700_000_000,
          end_date: 1_702_592_000,
        },
        // One Builder cycle, then the schedule releases the subscription.
        {
          items: [{ price: "price_builder_live", quantity: 1 }],
          duration: { interval: "month", interval_count: 1 },
        },
      ],
    });
  });
});

describe("cancelPlan", () => {
  it("walls the cancellation while membership exceeds the Free seat cap", async () => {
    builder._memberCount = 3;
    const { cancelPlan } = await import("../billing-plan");
    const result = await cancelPlan();
    expect((result as { error: string }).error).toContain("remove members to continue");
    expect(mockSubUpdate).not.toHaveBeenCalled();
  });

  it("schedules the cancellation for period end", async () => {
    const { cancelPlan } = await import("../billing-plan");
    expect(await cancelPlan()).toEqual({ ok: true });
    expect(mockSubUpdate).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ name: "billing.cancellation_scheduled" }),
      { userId: "user_abc" }
    );
  });

  it("releases a pending downgrade schedule first (cancel supersedes)", async () => {
    builder._mirror = mirror({
      stripe_price_id: "price_scale_live",
      stripe_schedule_id: "sched_1",
    });
    const { cancelPlan } = await import("../billing-plan");
    expect(await cancelPlan()).toEqual({ ok: true });
    expect(mockSchedRelease).toHaveBeenCalledWith("sched_1");
    expect(mockSubUpdate).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
  });
});

describe("keepPlan", () => {
  it("reverts a scheduled cancellation", async () => {
    builder._mirror = mirror({ cancel_at_period_end: true });
    const { keepPlan } = await import("../billing-plan");
    expect(await keepPlan()).toEqual({ ok: true });
    expect(mockSubUpdate).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: false });
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ name: "billing.scheduled_change_reverted" }),
      { userId: "user_abc" }
    );
  });

  it("releases a scheduled downgrade", async () => {
    builder._mirror = mirror({ stripe_schedule_id: "sched_1" });
    const { keepPlan } = await import("../billing-plan");
    expect(await keepPlan()).toEqual({ ok: true });
    expect(mockSchedRelease).toHaveBeenCalledWith("sched_1");
    expect(mockSubUpdate).not.toHaveBeenCalled();
  });

  it("reports when nothing is scheduled", async () => {
    const { keepPlan } = await import("../billing-plan");
    expect(await keepPlan()).toEqual({
      error: "No scheduled change to keep your plan from",
    });
  });

  it("surfaces Stripe failures as a retryable error", async () => {
    builder._mirror = mirror({ cancel_at_period_end: true });
    mockSubUpdate.mockRejectedValue(new Error("stripe down"));
    const { keepPlan } = await import("../billing-plan");
    expect(await keepPlan()).toEqual({
      error: "Couldn't revert the scheduled change. Please try again.",
    });
  });

  it("treats an already-released schedule as success (mirror lags the webhook)", async () => {
    // Second click before the `released` event lands: Stripe refuses the
    // release, but the schedule is already in the desired end state.
    builder._mirror = mirror({ stripe_schedule_id: "sched_1" });
    mockSchedRelease.mockRejectedValue(new Error("schedule already released"));
    mockSchedRetrieve.mockResolvedValue({ id: "sched_1", status: "released" });
    const { keepPlan } = await import("../billing-plan");
    expect(await keepPlan()).toEqual({ ok: true });
  });
});

// past_due is a LIVE subscription in payment trouble: the Team must still be
// able to cancel (stop being charged) and revert a scheduled change, but not
// grow the plan until payment recovers (#182).
describe("plan changes while past_due", () => {
  it("allows cancelling", async () => {
    builder._mirror = mirror({ status: "past_due" });
    const { cancelPlan } = await import("../billing-plan");
    expect(await cancelPlan()).toEqual({ ok: true });
    expect(mockSubUpdate).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
  });

  it("allows reverting a scheduled change", async () => {
    builder._mirror = mirror({ status: "past_due", cancel_at_period_end: true });
    const { keepPlan } = await import("../billing-plan");
    expect(await keepPlan()).toEqual({ ok: true });
  });

  it("refuses upgrades until payment recovers", async () => {
    builder._mirror = mirror({ status: "past_due" });
    const { upgradeToScale } = await import("../billing-plan");
    expect(await upgradeToScale()).toEqual({
      error:
        "Plan changes are paused until the payment goes through — update your payment method first.",
    });
    expect(mockSubUpdate).not.toHaveBeenCalled();
  });

  it("refuses scheduling a downgrade until payment recovers", async () => {
    builder._mirror = mirror({ status: "past_due", stripe_price_id: "price_scale_live" });
    const { scheduleDowngradeToBuilder } = await import("../billing-plan");
    expect(await scheduleDowngradeToBuilder()).toEqual({
      error:
        "Plan changes are paused until the payment goes through — update your payment method first.",
    });
    expect(mockSchedCreate).not.toHaveBeenCalled();
  });
});
