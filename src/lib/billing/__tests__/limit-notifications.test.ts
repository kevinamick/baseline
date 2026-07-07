import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockUpsertSelect, mockListOrgMembers, mockGetOrgName, mockSendEmail, mockLogError } =
  vi.hoisted(() => ({
    mockUpsertSelect: vi.fn(),
    mockListOrgMembers: vi.fn(),
    mockGetOrgName: vi.fn(),
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
vi.mock("@/lib/auth/members", () => ({
  listOrgMembers: mockListOrgMembers,
  getOrgName: mockGetOrgName,
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

const ADMIN = { userId: "u1", email: "admin@acme.com", role: "admin" as const };
const MEMBER = { userId: "u2", email: "member@acme.com", role: "member" as const };
const ADMIN_NO_EMAIL = { userId: "u3", email: null, role: "admin" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsertSelect.mockResolvedValue({ data: [{ org_id: "org1" }], error: null });
  mockListOrgMembers.mockResolvedValue([ADMIN, MEMBER]);
  mockGetOrgName.mockResolvedValue("Acme");
  mockSendEmail.mockResolvedValue(undefined);
});

describe("notifyLimitOnce (#180/#181)", () => {
  const opts = {
    orgId: "org1",
    kind: "points_limit",
    periodStart: "2026-06-01",
    subject: (teamName: string) => `${teamName} subject`,
    html: (teamName: string, billingUrl: string) => `<p>${teamName} ${billingUrl}</p>`,
  };

  it("sends to admins only, not regular members", async () => {
    await notifyLimitOnce(opts);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@acme.com", subject: "Acme subject" })
    );
  });

  it("skips admins with no resolvable email", async () => {
    mockListOrgMembers.mockResolvedValue([ADMIN, ADMIN_NO_EMAIL]);
    await notifyLimitOnce(opts);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@acme.com" })
    );
  });

  it("does not send when the throttle claim is already held (empty upsert result)", async () => {
    mockUpsertSelect.mockResolvedValue({ data: [], error: null });
    await notifyLimitOnce(opts);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockListOrgMembers).not.toHaveBeenCalled();
  });

  it("does not send when the throttle claim returns null data", async () => {
    mockUpsertSelect.mockResolvedValue({ data: null, error: null });
    await notifyLimitOnce(opts);

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("builds the billing URL from NEXT_PUBLIC_APP_URL", async () => {
    const originalUrl = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    try {
      await notifyLimitOnce(opts);
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: "<p>Acme https://app.example.com/settings/billing</p>",
        })
      );
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = originalUrl;
    }
  });

  it("never throws: logs and swallows errors from the claim query", async () => {
    mockUpsertSelect.mockResolvedValue({ data: null, error: { message: "db down" } });

    await expect(notifyLimitOnce(opts)).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalledWith(
      "billing limit email failed",
      expect.objectContaining({ org_id: "org1", kind: "points_limit" })
    );
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("never throws: logs and swallows errors from sendEmail", async () => {
    mockSendEmail.mockRejectedValue(new Error("smtp down"));

    await expect(notifyLimitOnce(opts)).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalledWith(
      "billing limit email failed",
      expect.objectContaining({ org_id: "org1" })
    );
  });

  it("never throws: logs and swallows errors from member/org lookups", async () => {
    mockListOrgMembers.mockRejectedValue(new Error("lookup failed"));

    await expect(notifyLimitOnce(opts)).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalledOnce();
  });
});

describe("notifyPointsLimitOnce (#180)", () => {
  it("delegates to notifyLimitOnce with points_limit copy", async () => {
    await notifyPointsLimitOnce({
      orgId: "org1",
      periodStart: "2026-06-01",
      neededPoints: 500,
      remainingPoints: 120,
    });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const call = mockSendEmail.mock.calls[0][0];
    expect(call.subject).toBe("Acme has hit its Eval Point limit");
    expect(call.html).toContain("500 Eval Points");
    expect(call.html).toContain("120");
  });
});

describe("NOTIFICATION_TEMPLATES registry completeness (#386)", () => {
  it("has a template for every declared NotificationKind", () => {
    const kinds = Object.values(NOTIFICATION_KIND) as NotificationKind[];
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      const template = NOTIFICATION_TEMPLATES[kind];
      expect(template, `missing template for kind "${kind}"`).toBeDefined();
      expect(typeof template.subject).toBe("function");
      expect(typeof template.html).toBe("function");
    }
    // No stray templates for a kind that isn't declared.
    expect(Object.keys(NOTIFICATION_TEMPLATES).sort()).toEqual([...kinds].sort());
  });
});

describe("notifyBillingLimit (#386) — characterization: rendered output matches the pre-refactor wrappers", () => {
  it("points_limit", async () => {
    await notifyBillingLimit(NOTIFICATION_KIND.pointsLimit, "org1", "2026-06-01", {
      neededPoints: 500,
      remainingPoints: 120,
    });
    const call = mockSendEmail.mock.calls[0][0];
    expect(call.subject).toBe("Acme has hit its Eval Point limit");
    expect(call.html).toContain("500 Eval Points");
    expect(call.html).toContain("120");
  });

  it("overage_limit", async () => {
    await notifyBillingLimit(NOTIFICATION_KIND.overageLimit, "org1", "2026-06-01", { capUsd: 25 });
    const call = mockSendEmail.mock.calls[0][0];
    expect(call.subject).toBe("Acme has reached its overage cap");
    expect(call.html).toContain("$25.00");
  });

  it("overage_warning", async () => {
    await notifyBillingLimit(NOTIFICATION_KIND.overageWarning, "org1", "2026-06-01", {
      committedUsd: 8.5,
      capUsd: 10,
    });
    const call = mockSendEmail.mock.calls[0][0];
    expect(call.subject).toBe("Acme is approaching its overage cap");
    expect(call.html).toContain("$8.50");
    expect(call.html).toContain("$10.00");
  });

  it("managed_spend_limit", async () => {
    await notifyBillingLimit(NOTIFICATION_KIND.managedSpendLimit, "org1", "2026-06-01", {
      capUsd: 25,
    });
    const call = mockSendEmail.mock.calls[0][0];
    expect(call.subject).toBe("Acme has reached its managed spend cap");
    expect(call.html).toContain("$25.00");
  });

  it("managed_payment_failed", async () => {
    await notifyBillingLimit(NOTIFICATION_KIND.managedPaymentFailed, "org1", "2026-06-01", {
      amountUsd: 10,
    });
    const call = mockSendEmail.mock.calls[0][0];
    expect(call.subject).toBe("Acme: managed token payment failed");
    expect(call.html).toContain("$10.00");
  });

  it("optimization_runs_limit", async () => {
    await notifyBillingLimit(NOTIFICATION_KIND.optimizationRunsLimit, "org1", "2026-06-01", {
      included: 15,
    });
    const call = mockSendEmail.mock.calls[0][0];
    expect(call.subject).toBe("Acme has used its Optimization Runs for this period");
    expect(call.html).toContain("15");
  });
});
