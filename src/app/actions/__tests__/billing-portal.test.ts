import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("server-only", () => ({}));

const mockGetAuthContext = vi.fn();
const mockTrack = vi.fn();
const mockRedirect = vi.fn(() => {
  throw new Error("NEXT_REDIRECT");
});

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

interface MockBuilder {
  _result: unknown;
  from: Mock;
  select: Mock;
  eq: Mock;
  maybeSingle: Mock;
}
const builder: MockBuilder = {
  _result: { data: null, error: null },
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
};
for (const method of ["from", "select", "eq"] as const) {
  builder[method].mockReturnValue(builder);
}
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: builder }));

const mockSessionCreate = vi.fn();
const mockConfigList = vi.fn();
const mockConfigCreate = vi.fn();
vi.mock("@/lib/stripe", () => ({
  stripe: {
    billingPortal: {
      sessions: { create: mockSessionCreate },
      configurations: { list: mockConfigList, create: mockConfigCreate },
    },
  },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env.STRIPE_PORTAL_CONFIG_ID;
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  mockGetAuthContext.mockResolvedValue({
    userId: "user_abc",
    orgId: "org_abc",
    role: "admin",
    canWrite: true,
  });
  builder.maybeSingle.mockResolvedValue({
    data: { stripe_customer_id: "cus_123" },
    error: null,
  });
  mockConfigList.mockResolvedValue({ data: [] });
  mockConfigCreate.mockResolvedValue({ id: "bpc_new" });
  mockSessionCreate.mockResolvedValue({ url: "https://billing.stripe.com/session/xyz" });
  const { resetPortalConfigCache } = await import("@/lib/billing/portal-config");
  resetPortalConfigCache();
});

describe("openBillingPortal", () => {
  it("rejects signed-out callers", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, canWrite: false });
    const { openBillingPortal } = await import("../billing-portal");
    await expect(openBillingPortal()).rejects.toThrow("Not signed in");
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("rejects readonly members", async () => {
    mockGetAuthContext.mockResolvedValue({
      userId: "user_ro",
      orgId: "org_abc",
      role: "member",
      canWrite: false,
    });
    const { openBillingPortal } = await import("../billing-portal");
    await expect(openBillingPortal()).rejects.toThrow("Only contributors can manage billing");
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("fails closed for Teams without a Stripe customer", async () => {
    builder.maybeSingle.mockResolvedValue({ data: null, error: null });
    const { openBillingPortal } = await import("../billing-portal");
    await expect(openBillingPortal()).rejects.toThrow("no billing account");
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("creates a portal session for the Team's customer and redirects", async () => {
    const { openBillingPortal } = await import("../billing-portal");
    await expect(openBillingPortal()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockSessionCreate).toHaveBeenCalledWith({
      customer: "cus_123",
      configuration: "bpc_new",
      return_url: "http://localhost:3000/settings/billing",
    });
    expect(mockRedirect).toHaveBeenCalledWith("https://billing.stripe.com/session/xyz");
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ name: "billing.portal_opened" }),
      { userId: "user_abc" }
    );
  });
});

describe("getPortalConfigurationId", () => {
  it("pins to STRIPE_PORTAL_CONFIG_ID when set", async () => {
    process.env.STRIPE_PORTAL_CONFIG_ID = "bpc_pinned";
    const { getPortalConfigurationId } = await import("@/lib/billing/portal-config");
    expect(await getPortalConfigurationId()).toBe("bpc_pinned");
    expect(mockConfigList).not.toHaveBeenCalled();
  });

  it("reuses an existing marked configuration", async () => {
    mockConfigList.mockResolvedValue({
      data: [
        { id: "bpc_other", active: true, metadata: {} },
        { id: "bpc_ours", active: true, metadata: { baseline: "baseline_billing_page_v1" } },
      ],
    });
    const { getPortalConfigurationId } = await import("@/lib/billing/portal-config");
    expect(await getPortalConfigurationId()).toBe("bpc_ours");
    expect(mockConfigCreate).not.toHaveBeenCalled();
  });

  it("creates the restricted configuration when none exists — cancel and plan switching stay disabled", async () => {
    const { getPortalConfigurationId } = await import("@/lib/billing/portal-config");
    expect(await getPortalConfigurationId()).toBe("bpc_new");
    expect(mockConfigCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        features: expect.objectContaining({
          payment_method_update: { enabled: true },
          invoice_history: { enabled: true },
          customer_update: expect.objectContaining({ enabled: true }),
          subscription_cancel: { enabled: false },
          subscription_update: { enabled: false },
        }),
      })
    );
  });

  it("caches the resolved id per process", async () => {
    const { getPortalConfigurationId } = await import("@/lib/billing/portal-config");
    await getPortalConfigurationId();
    await getPortalConfigurationId();
    expect(mockConfigList).toHaveBeenCalledTimes(1);
    expect(mockConfigCreate).toHaveBeenCalledTimes(1);
  });
});
