import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// vi.hoisted: referenced inside the hoisted vi.mock factory below.
const { mockRpc, mockInsert, mockFrom, mockLogError } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockInsert: vi.fn(),
  mockFrom: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { rpc: mockRpc, from: mockFrom },
}));
vi.mock("@/lib/logging/server", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: mockLogError },
}));

import {
  claimAccessCode,
  releaseAccessCodeClaim,
  recordAccessCodeRedemption,
} from "../redeem";

beforeEach(() => {
  vi.clearAllMocks();
  mockFrom.mockReturnValue({ insert: mockInsert });
});

describe("claimAccessCode", () => {
  it("maps a successful claim row (snake_case RPC output) to the camelCase result", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          claimed: true,
          status: "claimed",
          access_code_id: "code-1",
          trial_days: 14,
          stripe_coupon_id: "coupon_1",
          plan_slug: "builder",
        },
      ],
      error: null,
    });

    const result = await claimAccessCode("LAUNCH2026");

    expect(mockRpc).toHaveBeenCalledWith("claim_access_code", { p_code: "LAUNCH2026" });
    expect(result).toEqual({
      claimed: true,
      status: "claimed",
      accessCodeId: "code-1",
      trialDays: 14,
      stripeCouponId: "coupon_1",
      planSlug: "builder",
    });
  });

  it("handles a single-object RPC response (not just an array)", async () => {
    mockRpc.mockResolvedValue({
      data: {
        claimed: false,
        status: "exhausted",
        access_code_id: "code-2",
        trial_days: null,
        stripe_coupon_id: null,
        plan_slug: null,
      },
      error: null,
    });

    const result = await claimAccessCode("FULL");
    expect(result.claimed).toBe(false);
    expect(result.status).toBe("exhausted");
    expect(result.accessCodeId).toBe("code-2");
  });

  it("fails CLOSED (not_found) and logs when the RPC errors", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "connection reset" } });

    const result = await claimAccessCode("ANY");

    expect(result).toEqual({
      claimed: false,
      status: "not_found",
      accessCodeId: null,
      trialDays: null,
      stripeCouponId: null,
      planSlug: null,
    });
    expect(mockLogError).toHaveBeenCalledWith("access code claim RPC failed", {
      event: "access_code.claim_failed",
      error: { message: "connection reset" },
    });
  });

  it("fails CLOSED when the RPC returns no row at all", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const result = await claimAccessCode("ANY");
    expect(result.claimed).toBe(false);
    expect(result.status).toBe("not_found");
  });
});

describe("releaseAccessCodeClaim", () => {
  it("calls the release RPC with the access code id", async () => {
    mockRpc.mockResolvedValue({ error: null });
    await releaseAccessCodeClaim("code-1");
    expect(mockRpc).toHaveBeenCalledWith("release_access_code_claim", {
      p_access_code_id: "code-1",
    });
  });

  it("swallows (logs, doesn't throw) an RPC error", async () => {
    mockRpc.mockResolvedValue({ error: { message: "boom" } });
    await expect(releaseAccessCodeClaim("code-1")).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalledWith("access code release RPC failed", {
      event: "access_code.release_failed",
      access_code_id: "code-1",
      error: { message: "boom" },
    });
  });
});

describe("recordAccessCodeRedemption", () => {
  it("inserts a redemption row tying the code to the new user", async () => {
    mockInsert.mockResolvedValue({ error: null });
    await recordAccessCodeRedemption("code-1", "user-1");
    expect(mockFrom).toHaveBeenCalledWith("access_code_redemptions");
    expect(mockInsert).toHaveBeenCalledWith({
      access_code_id: "code-1",
      user_id: "user-1",
    });
  });

  it("swallows (logs, doesn't throw) an insert error", async () => {
    mockInsert.mockResolvedValue({ error: { message: "boom" } });
    await expect(
      recordAccessCodeRedemption("code-1", "user-1")
    ).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalledWith("access code redemption record failed", {
      event: "access_code.redemption_record_failed",
      access_code_id: "code-1",
      user_id: "user-1",
      error: { message: "boom" },
    });
  });
});
