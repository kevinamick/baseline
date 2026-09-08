import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockUpsertSelect, mockSendEmail, mockLogError } = vi.hoisted(() => ({
  mockUpsertSelect: vi.fn(),
  mockSendEmail: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({
      upsert: () => ({ select: mockUpsertSelect }),
    }),
  },
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/logging/server", () => ({ log: { error: mockLogError } }));

import {
  notifyLimitOnce,
  notifyPointsLimitOnce,
  notifyBillingLimit,
  NOTIFICATION_KIND,
  NOTIFICATION_TEMPLATES,
  type NotificationKind,
} from "../limit-notifications";

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsertSelect.mockResolvedValue({ data: [{ org_id: "org1" }], error: null });
  mockSendEmail.mockResolvedValue(undefined);
});

describe("notifyLimitOnce (#180/#181) in the Local Workspace (ADR-0020)", () => {
  const opts = {
    orgId: "org1",
    kind: "points_limit",
    periodStart: "2026-06-01",
    subject: (teamName: string) => `${teamName} subject`,
    html: (teamName: string, billingUrl: string) => `<p>${teamName} ${billingUrl}</p>`,
  };

  it("claims the once-per-period throttle but sends nothing: the Workspace has no member addresses", async () => {
    await notifyLimitOnce(opts);

    expect(mockUpsertSelect).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("never throws: logs and swallows errors from the claim query", async () => {
    mockUpsertSelect.mockResolvedValue({ data: null, error: { message: "db down" } });

    await expect(notifyLimitOnce(opts)).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalledWith(
      "billing limit email failed",
      expect.objectContaining({ org_id: "org1", kind: "points_limit" })
    );
  });
});

describe("notifyPointsLimitOnce (#180)", () => {
  it("delegates to notifyLimitOnce with points_limit copy", async () => {
    await notifyPointsLimitOnce({
      orgId: "org1",
      periodStart: "2026-06-01",
      neededPoints: 10,
      remainingPoints: 2,
    });
    expect(mockUpsertSelect).toHaveBeenCalledTimes(1);
  });
});

describe("NOTIFICATION_TEMPLATES registry (#386)", () => {
  it("has a template for every kind", () => {
    for (const kind of Object.values(NOTIFICATION_KIND) as NotificationKind[]) {
      expect(NOTIFICATION_TEMPLATES[kind]).toBeDefined();
      expect(NOTIFICATION_TEMPLATES[kind].subject("Acme")).toEqual(expect.any(String));
    }
  });

  it("notifyBillingLimit claims the throttle for the given kind", async () => {
    await notifyBillingLimit(NOTIFICATION_KIND.overageLimit, "org1", "2026-06-01", {
      capUsd: 25,
    });
    expect(mockUpsertSelect).toHaveBeenCalledTimes(1);
  });
});
