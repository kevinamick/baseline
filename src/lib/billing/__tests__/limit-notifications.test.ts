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

import { notifyLimitOnce, notifyPointsLimitOnce } from "../limit-notifications";

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
