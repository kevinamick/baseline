import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockGate } = vi.hoisted(() => ({ mockGate: vi.fn() }));
vi.mock("@/lib/billing/claim-gate", () => ({ gateScheduledRunBilling: mockGate }));
vi.mock("@/lib/logging/server", () => ({ log: { info: vi.fn(), error: vi.fn() } }));

import { POST } from "../route";

function post(body: unknown, auth?: string): Request {
  return new Request("http://localhost/api/internal/claim-reserve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const SECRET = "test-claim-secret";

describe("POST /api/internal/claim-reserve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLAIM_RESERVE_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.CLAIM_RESERVE_SECRET;
  });

  it("503 when the secret is not configured (fail closed)", async () => {
    delete process.env.CLAIM_RESERVE_SECRET;
    const res = await POST(post({ runId: "r1" }, `Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it("401 on a wrong or absent bearer secret", async () => {
    expect((await POST(post({ runId: "r1" }, "Bearer nope"))).status).toBe(401);
    expect((await POST(post({ runId: "r1" }))).status).toBe(401);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it("400 on a missing/invalid runId", async () => {
    expect((await POST(post({}, `Bearer ${SECRET}`))).status).toBe(400);
    expect((await POST(post("not json", `Bearer ${SECRET}`))).status).toBe(400);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it("returns the gate decision on a valid authed request", async () => {
    mockGate.mockResolvedValue({ allowed: false, reason: "insufficient_points" });
    const res = await POST(post({ runId: "run-123" }, `Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: false, reason: "insufficient_points" });
    expect(mockGate).toHaveBeenCalledWith("run-123");
  });

  it("passes an allow decision through", async () => {
    mockGate.mockResolvedValue({ allowed: true });
    const res = await POST(post({ runId: "run-9" }, `Bearer ${SECRET}`));
    expect(await res.json()).toEqual({ allowed: true });
  });

  it("500 when gateScheduledRunBilling throws (DB error fails closed)", async () => {
    mockGate.mockRejectedValue(new Error("DB connection error"));
    const res = await POST(post({ runId: "run-err" }, `Bearer ${SECRET}`));
    expect(res.status).toBe(500);
  });
});
