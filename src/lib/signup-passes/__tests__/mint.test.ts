import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
// after() runs post-response in prod; invoke the callback inline in tests so
// the deferred purge + failure logs are exercised synchronously.
vi.mock("next/server", () => ({ after: (cb: () => unknown) => cb() }));

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
  // The purge is sampled (runs on a small random fraction of mints, #489).
  // Default to "sampled in" so the mint's core behavior is deterministic; the
  // sampling itself is asserted by driving Math.random per test.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mintSignupPass", () => {
  it("inserts a pass row bound to the email and a per-request nonce, and returns that nonce", async () => {
    const nonce = await mintSignupPass("new@acme.com");
    expect(typeof nonce).toBe("string");
    expect(nonce).toBeTruthy();
    expect(mockFrom).toHaveBeenCalledWith("signup_passes");
    // The row carries the SAME nonce that is returned to the caller (which the
    // action threads into options.data so the hook can match it).
    expect(mockInsert).toHaveBeenCalledWith({ email: "new@acme.com", nonce });
  });

  it("returns a fresh, unguessable nonce on each mint", async () => {
    const a = await mintSignupPass("a@acme.com");
    const b = await mintSignupPass("a@acme.com");
    expect(a).not.toEqual(b);
    // 32 random bytes as base64url — long enough to be unguessable.
    expect((a ?? "").length).toBeGreaterThanOrEqual(43);
  });

  it("fails CLOSED (null) and logs when the insert errors", async () => {
    mockInsert.mockResolvedValue({ error: { message: "connection reset" } });
    await expect(mintSignupPass("new@acme.com")).resolves.toBeNull();
    expect(mockLogError).toHaveBeenCalledWith("signup pass mint failed", {
      event: "signup_pass.mint_failed",
      email_domain: "acme.com",
      error: { message: "connection reset" },
    });
  });

  it("opportunistically purges long-dead rows when sampled in (deferred off the response)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // below the sample rate → purge runs
    await mintSignupPass("new@acme.com");
    expect(mockDelete).toHaveBeenCalled();
    // The purge cutoff sits well behind the pass TTL: an hour ago, not "now",
    // so a still-consumable pass can never be swept out from under a signUp.
    const cutoff = new Date(mockLt.mock.calls[0][1] as string).getTime();
    expect(mockLt).toHaveBeenCalledWith("expires_at", expect.any(String));
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(59 * 60 * 1000);
  });

  it("still mints (and logs a warn, not an error) when the purge fails", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // sampled in so the purge actually runs
    mockLt.mockResolvedValue({ error: { message: "purge boom" } });
    const nonce = await mintSignupPass("new@acme.com");
    expect(nonce).toBeTruthy();
    expect(mockInsert).toHaveBeenCalledWith({ email: "new@acme.com", nonce });
    expect(mockLogWarn).toHaveBeenCalledWith("signup pass purge failed", {
      event: "signup_pass.purge_failed",
      error: { message: "purge boom" },
    });
  });

  it("skips the purge on most mints (probabilistic guard, #489), still minting the pass", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99); // above the sample rate → no purge
    const nonce = await mintSignupPass("new@acme.com");
    // The mint itself is unconditional; only the housekeeping DELETE is sampled.
    expect(nonce).toBeTruthy();
    expect(mockInsert).toHaveBeenCalledWith({ email: "new@acme.com", nonce });
    expect(mockDelete).not.toHaveBeenCalled();
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
