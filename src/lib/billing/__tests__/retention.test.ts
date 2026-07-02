import { describe, it, expect, vi, beforeEach } from "vitest";

// retention.ts is server-only and pulls in the admin client + email/notification
// deps at import; stub them so the pure window-math helpers import in node.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/logging/server", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { mockGetBillingState, mockIsEndedStatus, mockNotifyLimitOnce, mockRpcOrThrow } = vi.hoisted(() => ({
  mockGetBillingState: vi.fn(),
  mockIsEndedStatus: vi.fn(),
  mockNotifyLimitOnce: vi.fn(),
  mockRpcOrThrow: vi.fn(),
}));
vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState, isEndedStatus: mockIsEndedStatus }));
vi.mock("@/lib/billing/limit-notifications", () => ({ notifyLimitOnce: mockNotifyLimitOnce }));
vi.mock("@/lib/supabase/rpc", () => ({ rpcOrThrow: mockRpcOrThrow }));

import {
  retentionCutoffIso,
  purgeDateIso,
  isRetentionDowngrade,
  isPurgeEligible,
  RETENTION_GRACE_DAYS,
  retentionCandidateOrgs,
  sweepRetentionForOrg,
  applyRetentionForPlanChange,
} from "../retention";
import { PLANS } from "../plans";
import { retentionWindowText } from "@/app/_components/retention-window-note";

beforeEach(() => vi.clearAllMocks());

const DAY = 86_400_000;
// A fixed clock so the math is exact, not relative to a moving "now".
const NOW = Date.parse("2026-06-15T12:00:00.000Z");

/**
 * Retention Window math (#187, ADR-0008). A run is out of window when it was
 * created before now − retentionDays; purge is eligible only ≥30 days after
 * soft-deletion. These are the predicates the SQL acts on, kept pure here.
 */
describe("retentionCutoffIso", () => {
  it("computes the window boundary for each plan", () => {
    expect(retentionCutoffIso(PLANS.free.retentionDays, NOW)).toBe(
      new Date(NOW - 14 * DAY).toISOString(),
    );
    expect(retentionCutoffIso(PLANS.builder.retentionDays, NOW)).toBe(
      new Date(NOW - 90 * DAY).toISOString(),
    );
    expect(retentionCutoffIso(PLANS.scale.retentionDays, NOW)).toBe(
      new Date(NOW - 1_095 * DAY).toISOString(),
    );
  });

  it("classifies a run as in- or out-of-window against the cutoff", () => {
    const cutoff = retentionCutoffIso(PLANS.builder.retentionDays, NOW); // 90 days
    const day89 = new Date(NOW - 89 * DAY).toISOString();
    const day91 = new Date(NOW - 91 * DAY).toISOString();
    expect(day89 < cutoff).toBe(false); // still in window — kept
    expect(day91 < cutoff).toBe(true); // past the window — soft-deleted
  });
});

describe("purgeDateIso", () => {
  it("is 30 days after soft-deletion by default", () => {
    expect(purgeDateIso(NOW)).toBe(new Date(NOW + 30 * DAY).toISOString());
    expect(RETENTION_GRACE_DAYS).toBe(30);
  });
});

describe("isRetentionDowngrade", () => {
  it("is true only when the new window is smaller (a cliff)", () => {
    expect(isRetentionDowngrade(PLANS.scale.retentionDays, PLANS.builder.retentionDays)).toBe(true);
    expect(isRetentionDowngrade(PLANS.builder.retentionDays, PLANS.free.retentionDays)).toBe(true);
    expect(isRetentionDowngrade(PLANS.free.retentionDays, PLANS.scale.retentionDays)).toBe(false);
    expect(isRetentionDowngrade(90, 90)).toBe(false);
  });
});

describe("isPurgeEligible", () => {
  it("never purges live (never-soft-deleted) data", () => {
    expect(isPurgeEligible(null, NOW)).toBe(false);
  });

  it("never purges within the 30-day grace, including the exact boundary", () => {
    expect(isPurgeEligible(NOW - 29 * DAY, NOW)).toBe(false);
    expect(isPurgeEligible(NOW - 30 * DAY, NOW)).toBe(false); // strictly older than grace
  });

  it("purges only once past the grace window", () => {
    expect(isPurgeEligible(NOW - 31 * DAY, NOW)).toBe(true);
    expect(isPurgeEligible(NOW - 400 * DAY, NOW)).toBe(true);
  });
});

describe("retentionWindowText", () => {
  it("renders days, and whole years for the 3-year plan", () => {
    expect(retentionWindowText(14)).toBe("the last 14 days");
    expect(retentionWindowText(90)).toBe("the last 90 days");
    expect(retentionWindowText(1_095)).toBe("the last 3 years");
  });
});

describe("retentionCandidateOrgs", () => {
  it("normalizes a bare-scalar array", async () => {
    mockRpcOrThrow.mockResolvedValue(["org_1", "org_2"]);
    expect(await retentionCandidateOrgs()).toEqual(["org_1", "org_2"]);
  });

  it("normalizes a {fn_name} row-object array", async () => {
    mockRpcOrThrow.mockResolvedValue([{ retention_candidate_orgs: "org_1" }]);
    expect(await retentionCandidateOrgs()).toEqual(["org_1"]);
  });

  it("is empty when the RPC returns null", async () => {
    mockRpcOrThrow.mockResolvedValue(null);
    expect(await retentionCandidateOrgs()).toEqual([]);
  });
});

describe("sweepRetentionForOrg", () => {
  it("follows the SUBSCRIBED plan (planForPriceId), not the quota floor, when not ended", async () => {
    process.env.STRIPE_PRICE_BUILDER = "price_builder_live";
    mockGetBillingState.mockResolvedValue({ status: "past_due", priceId: "price_builder_live" });
    mockIsEndedStatus.mockReturnValue(false);
    mockRpcOrThrow.mockResolvedValue(null);
    await sweepRetentionForOrg("org_1", NOW);
    expect(mockRpcOrThrow).toHaveBeenCalledWith("expire_runs_before", {
      p_org_id: "org_1",
      p_cutoff: retentionCutoffIso(PLANS.builder.retentionDays, NOW),
    });
  });

  it("floors to the Free window once the subscription has genuinely ended", async () => {
    mockGetBillingState.mockResolvedValue({ status: "canceled", priceId: "price_builder_live" });
    mockIsEndedStatus.mockReturnValue(true);
    mockRpcOrThrow.mockResolvedValue(null);
    await sweepRetentionForOrg("org_1", NOW);
    expect(mockRpcOrThrow).toHaveBeenCalledWith("expire_runs_before", {
      p_org_id: "org_1",
      p_cutoff: retentionCutoffIso(PLANS.free.retentionDays, NOW),
    });
  });

  it("floors to Free for an unrecognized/retired price (planForPriceId → null)", async () => {
    mockGetBillingState.mockResolvedValue({ status: "past_due", priceId: "price_retired" });
    mockIsEndedStatus.mockReturnValue(false);
    mockRpcOrThrow.mockResolvedValue(null);
    await sweepRetentionForOrg("org_1", NOW);
    expect(mockRpcOrThrow).toHaveBeenCalledWith("expire_runs_before", {
      p_org_id: "org_1",
      p_cutoff: retentionCutoffIso(PLANS.free.retentionDays, NOW),
    });
  });

  it("never throws — a bad org must not abort the sweep", async () => {
    mockGetBillingState.mockRejectedValue(new Error("db down"));
    await expect(sweepRetentionForOrg("org_1", NOW)).resolves.toBeUndefined();
  });
});

describe("applyRetentionForPlanChange", () => {
  const periodStart = "2026-06-01T00:00:00.000Z";

  it("on a downgrade with expired runs, soft-deletes and emails once", async () => {
    mockRpcOrThrow.mockResolvedValue([{ eval_expired: 2, opt_expired: 1 }]);
    // Exercise the subject/html builders too — notifyLimitOnce itself is mocked,
    // so nothing calls them unless the test does.
    mockNotifyLimitOnce.mockImplementation(async (opts) => {
      expect(opts.subject("Acme")).toBe("Acme: 3 runs moved out of your retention window");
      expect(opts.html("Acme", "https://app.example.com/settings/billing")).toEqual(expect.any(String));
    });
    await applyRetentionForPlanChange("org_1", "scale", "builder", periodStart, NOW);
    expect(mockRpcOrThrow).toHaveBeenCalledWith(
      "expire_runs_before",
      expect.objectContaining({ p_org_id: "org_1" })
    );
    expect(mockNotifyLimitOnce).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", kind: "retention_downgrade", periodStart })
    );
  });

  it("singularizes the subject line for exactly one moved run", async () => {
    mockRpcOrThrow.mockResolvedValue([{ eval_expired: 1, opt_expired: 0 }]);
    mockNotifyLimitOnce.mockImplementation(async (opts) => {
      expect(opts.subject("Acme")).toBe("Acme: 1 run moved out of your retention window");
    });
    await applyRetentionForPlanChange("org_1", "scale", "builder", periodStart, NOW);
    expect(mockNotifyLimitOnce).toHaveBeenCalled();
  });

  it("on a downgrade with nothing actually out of window, stays silent", async () => {
    mockRpcOrThrow.mockResolvedValue([{ eval_expired: 0, opt_expired: 0 }]);
    await applyRetentionForPlanChange("org_1", "scale", "builder", periodStart, NOW);
    expect(mockNotifyLimitOnce).not.toHaveBeenCalled();
  });

  it("on a growth (re-upgrade), restores instead of expiring", async () => {
    mockRpcOrThrow.mockResolvedValue(null);
    await applyRetentionForPlanChange("org_1", "builder", "scale", periodStart, NOW);
    expect(mockRpcOrThrow).toHaveBeenCalledWith(
      "restore_runs_since",
      expect.objectContaining({ p_org_id: "org_1" })
    );
    expect(mockNotifyLimitOnce).not.toHaveBeenCalled();
  });

  it("is a no-op for an equal-window plan change", async () => {
    await applyRetentionForPlanChange("org_1", "builder", "builder", periodStart, NOW);
    expect(mockRpcOrThrow).not.toHaveBeenCalled();
    expect(mockNotifyLimitOnce).not.toHaveBeenCalled();
  });

  it("never throws — a failed side effect must not block the webhook's mirror write", async () => {
    mockRpcOrThrow.mockRejectedValue(new Error("db down"));
    await expect(
      applyRetentionForPlanChange("org_1", "scale", "builder", periodStart, NOW)
    ).resolves.toBeUndefined();
  });
});
