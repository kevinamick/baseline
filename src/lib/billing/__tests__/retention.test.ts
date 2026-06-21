import { describe, it, expect, vi } from "vitest";

// retention.ts is server-only and pulls in the admin client + email/notification
// deps at import; stub them so the pure window-math helpers import in node.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/logging/server", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/billing/state", () => ({ getBillingState: vi.fn(), isEndedStatus: vi.fn() }));
vi.mock("@/lib/billing/limit-notifications", () => ({ notifyLimitOnce: vi.fn() }));

import {
  retentionCutoffIso,
  purgeDateIso,
  isRetentionDowngrade,
  isPurgeEligible,
  RETENTION_GRACE_DAYS,
} from "../retention";
import { PLANS } from "../plans";
import { retentionWindowText } from "@/app/_components/retention-window-note";

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
