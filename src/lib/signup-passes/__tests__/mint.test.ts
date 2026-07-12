import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// vi.hoisted: referenced inside the hoisted vi.mock factory below.
const { mockFrom, mockInsert, mockDelete, mockLt, mockLogWarn, mockLogError } =
  vi.hoisted(() => ({
    mockFrom: vi.fn(),
    mockInsert: vi.fn(),
    mockDelete: vi.fn(),
    mockLt: vi.fn(),
    mockLogWarn: vi.fn(),
    mockLogError: vi.fn(),
  }));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mockFrom },
}));
vi.mock("@/lib/logging/server", () => ({
  log: { info: vi.fn(), warn: mockLogWarn, error: mockLogError },
}));

import { mintSignupPass, isSignupPassRejection, SIGNUP_PASS_REJECTION_MESSAGE } from "../mint";

beforeEach(() => {
  vi.clearAllMocks();
  mockFrom.mockReturnValue({ insert: mockInsert, delete: mockDelete });
  mockDelete.mockReturnValue({ lt: mockLt });
  mockLt.mockResolvedValue({ error: null });
  mockInsert.mockResolvedValue({ error: null });
});

describe("mintSignupPass", () => {
  it("inserts a pass row for the email and reports success", async () => {
    await expect(mintSignupPass("new@acme.com")).resolves.toBe(true);
    expect(mockFrom).toHaveBeenCalledWith("signup_passes");
    expect(mockInsert).toHaveBeenCalledWith({ email: "new@acme.com" });
  });

  it("fails CLOSED (false) and logs when the insert errors", async () => {
    mockInsert.mockResolvedValue({ error: { message: "connection reset" } });
    await expect(mintSignupPass("new@acme.com")).resolves.toBe(false);
    expect(mockLogError).toHaveBeenCalledWith("signup pass mint failed", {
      event: "signup_pass.mint_failed",
      email_domain: "acme.com",
      error: { message: "connection reset" },
    });
  });

  it("opportunistically purges long-dead rows before minting", async () => {
    await mintSignupPass("new@acme.com");
    expect(mockDelete).toHaveBeenCalled();
    // The purge cutoff sits well behind the pass TTL: an hour ago, not "now",
    // so a still-consumable pass can never be swept out from under a signUp.
    const cutoff = new Date(mockLt.mock.calls[0][1] as string).getTime();
    expect(mockLt).toHaveBeenCalledWith("expires_at", expect.any(String));
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(59 * 60 * 1000);
  });

  it("still mints (and logs a warn, not an error) when the purge fails", async () => {
    mockLt.mockResolvedValue({ error: { message: "purge boom" } });
    await expect(mintSignupPass("new@acme.com")).resolves.toBe(true);
    expect(mockInsert).toHaveBeenCalledWith({ email: "new@acme.com" });
    expect(mockLogWarn).toHaveBeenCalledWith("signup pass purge failed", {
      event: "signup_pass.purge_failed",
      error: { message: "purge boom" },
    });
  });
});

describe("isSignupPassRejection", () => {
  it("matches the hook's exact 403 + message shape", () => {
    expect(
      isSignupPassRejection({ status: 403, message: SIGNUP_PASS_REJECTION_MESSAGE })
    ).toBe(true);
  });

  it.each([
    ["another 403", { status: 403, message: "Forbidden" }],
    ["same message, different status", { status: 422, message: SIGNUP_PASS_REJECTION_MESSAGE }],
    ["ordinary provider error", { status: 422, message: "User already registered" }],
    ["no status at all", { message: SIGNUP_PASS_REJECTION_MESSAGE }],
  ])("does not match %s", (_label, error) => {
    expect(isSignupPassRejection(error)).toBe(false);
  });
});
