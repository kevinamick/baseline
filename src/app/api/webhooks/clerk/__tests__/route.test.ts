import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// --- Mocks ---

const mockVerifyWebhook = vi.fn();
vi.mock("@clerk/nextjs/webhooks", () => ({ verifyWebhook: mockVerifyWebhook }));

vi.mock("@/lib/analytics/server", () => ({ track: vi.fn() }));

const builder = {
  _result: { error: null } as { error: unknown },
  from: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
  eq: vi.fn(),
};
builder.from.mockReturnValue(builder);
builder.delete.mockReturnValue(builder);
builder.upsert.mockImplementation(() => Promise.resolve(builder._result));
builder.eq.mockImplementation(() => Promise.resolve(builder._result));

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: builder }));

// --- Helpers ---

function makeReq() {
  return {} as NextRequest;
}

// --- Tests ---

describe("Clerk webhook — organization.created", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    builder._result = { error: null };
    builder.from.mockReturnValue(builder);
    builder.delete.mockReturnValue(builder);
    builder.upsert.mockImplementation(() => Promise.resolve(builder._result));
    builder.eq.mockImplementation(() => Promise.resolve(builder._result));
  });

  it("upserts the org and returns 200 on success", async () => {
    mockVerifyWebhook.mockResolvedValue({ type: "organization.created", data: { id: "org_123" } });
    const { POST } = await import("../route");
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(builder.from).toHaveBeenCalledWith("organizations");
    expect(builder.upsert).toHaveBeenCalledWith(
      { id: "org_123" },
      { onConflict: "id", ignoreDuplicates: true }
    );
  });

  it("returns 500 when the upsert fails", async () => {
    builder.upsert.mockImplementation(() => Promise.resolve({ error: { message: "db error" } }));
    mockVerifyWebhook.mockResolvedValue({ type: "organization.created", data: { id: "org_123" } });
    const { POST } = await import("../route");
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
  });
});

describe("Clerk webhook — organization.deleted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    builder._result = { error: null };
    builder.from.mockReturnValue(builder);
    builder.delete.mockReturnValue(builder);
    builder.upsert.mockImplementation(() => Promise.resolve(builder._result));
    builder.eq.mockImplementation(() => Promise.resolve(builder._result));
  });

  it("deletes the org and returns 200 on success", async () => {
    mockVerifyWebhook.mockResolvedValue({ type: "organization.deleted", data: { id: "org_123" } });
    const { POST } = await import("../route");
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(builder.from).toHaveBeenCalledWith("organizations");
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("id", "org_123");
  });

  it("returns 200 without querying when event has no id", async () => {
    mockVerifyWebhook.mockResolvedValue({ type: "organization.deleted", data: {} });
    const { POST } = await import("../route");
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(builder.delete).not.toHaveBeenCalled();
  });

  it("returns 500 when the delete fails", async () => {
    builder.eq.mockImplementation(() => Promise.resolve({ error: { message: "db error" } }));
    mockVerifyWebhook.mockResolvedValue({ type: "organization.deleted", data: { id: "org_123" } });
    const { POST } = await import("../route");
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
  });
});

describe("Clerk webhook — general", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    builder._result = { error: null };
    builder.from.mockReturnValue(builder);
    builder.delete.mockReturnValue(builder);
    builder.upsert.mockImplementation(() => Promise.resolve(builder._result));
    builder.eq.mockImplementation(() => Promise.resolve(builder._result));
  });

  it("returns 400 when signature verification fails", async () => {
    mockVerifyWebhook.mockRejectedValue(new Error("bad signature"));
    const { POST } = await import("../route");
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
  });

  it("returns 200 for unhandled event types", async () => {
    mockVerifyWebhook.mockResolvedValue({ type: "session.created", data: {} });
    const { POST } = await import("../route");
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(builder.upsert).not.toHaveBeenCalled();
    expect(builder.delete).not.toHaveBeenCalled();
  });
});
