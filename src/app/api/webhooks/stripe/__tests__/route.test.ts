import { describe, it, expect, vi, beforeEach } from "vitest";

// The logging module has `import "server-only"`, which throws outside a server bundle.
vi.mock("server-only", () => ({}));

// vi.hoisted: referenced inside the hoisted vi.mock factories below.
const { mockConstructEvent, mockUpsert, mockTrack } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockUpsert: vi.fn(),
  mockTrack: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  stripe: { webhooks: { constructEvent: mockConstructEvent } },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: () => ({ upsert: mockUpsert }) },
}));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));

import { POST } from "../route";

function makeReq(sig: string | null = "sig") {
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: sig ? { "stripe-signature": sig } : {},
    body: "raw-body",
  });
}

function checkoutEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "checkout.session.completed",
    data: {
      object: {
        client_reference_id: "user-uuid",
        customer: "cus_1",
        subscription: "sub_1",
        customer_email: "buyer@acme.com",
        ...overrides,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsert.mockResolvedValue({ error: null });
});

describe("POST /api/webhooks/stripe", () => {
  it("upserts the customer keyed on the Supabase user_id", async () => {
    mockConstructEvent.mockReturnValue(checkoutEvent());

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-uuid",
        stripe_customer_id: "cus_1",
        stripe_subscription_id: "sub_1",
        email: "buyer@acme.com",
      }),
      { onConflict: "user_id" }
    );
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ name: "billing.subscription_started" }),
      expect.objectContaining({ userId: "user-uuid" })
    );
  });

  it("rejects a request with no stripe-signature", async () => {
    const res = await POST(makeReq(null));
    expect(res.status).toBe(400);
    expect(mockConstructEvent).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature", async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error("bad sig");
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("400s when the session is missing identifiers", async () => {
    mockConstructEvent.mockReturnValue(
      checkoutEvent({ client_reference_id: null })
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("ignores unrelated event types", async () => {
    mockConstructEvent.mockReturnValue({
      id: "evt_2",
      type: "invoice.paid",
      data: { object: {} },
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
