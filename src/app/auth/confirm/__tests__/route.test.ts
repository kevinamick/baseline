import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: referenced inside the hoisted vi.mock factories below.
const { mockVerifyOtp, mockRedirect, mockCheckLimit } = vi.hoisted(() => ({
  mockVerifyOtp: vi.fn(),
  mockRedirect: vi.fn((url: URL) => ({
    redirectedTo: url,
    cookies: { set: vi.fn() },
  })),
  mockCheckLimit: vi.fn(async () => false),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({ auth: { verifyOtp: mockVerifyOtp } })),
}));
vi.mock("next/server", () => {
  // Constructable (for the 429 path) with a static redirect (for the rest).
  function NextResponse(body: string, init?: { status?: number }) {
    return { body, status: init?.status ?? 200 };
  }
  NextResponse.redirect = mockRedirect;
  return { NextResponse };
});
vi.mock("@/lib/rate-limit/guard", () => ({
  checkLimit: mockCheckLimit,
  rateLimitMessage: () => "Too many requests. Please try again later.",
}));
vi.mock("@/lib/rate-limit/client-ip", () => ({
  clientIpFromHeaders: () => "203.0.113.7",
}));

import { GET } from "../route";

function makeReq(url: string) {
  return {
    url,
    headers: new Headers(),
    cookies: { getAll: () => [] },
  } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckLimit.mockReset().mockResolvedValue(false);
});

describe("GET /auth/confirm", () => {
  it("verifies the token and redirects to /dashboard", async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    await GET(
      makeReq("http://localhost/auth/confirm?token_hash=abc&type=email")
    );
    expect(mockVerifyOtp).toHaveBeenCalledWith({
      type: "email",
      token_hash: "abc",
    });
    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("http://localhost/dashboard")
    );
  });

  it("honors a relative `next` path on success", async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    await GET(
      makeReq(
        "http://localhost/auth/confirm?token_hash=abc&type=email&next=/rubrics"
      )
    );
    expect(mockRedirect).toHaveBeenCalledWith(new URL("http://localhost/rubrics"));
  });

  it.each([
    "https://evil.com",
    "//evil.com",
    "/\\evil.com",
    "http://localhost@evil.com", // userinfo trick: real host is evil.com
    "/\t/evil.com", // tab is stripped by the URL parser -> //evil.com
    "/\n//evil.com",
    "/\r/evil.com",
  ])("ignores an off-site `next` (%j) and falls back to /dashboard", async (next) => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    await GET(
      makeReq(
        `http://localhost/auth/confirm?token_hash=abc&type=email&next=${encodeURIComponent(next)}`
      )
    );
    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("http://localhost/dashboard")
    );
  });

  it("redirects to sign-in when verification fails", async () => {
    mockVerifyOtp.mockResolvedValue({ error: { message: "expired" } });
    await GET(
      makeReq("http://localhost/auth/confirm?token_hash=abc&type=email")
    );
    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("http://localhost/sign-in?error=confirm")
    );
  });

  it("redirects to sign-in when token params are missing", async () => {
    await GET(makeReq("http://localhost/auth/confirm"));
    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("http://localhost/sign-in?error=confirm")
    );
  });

  it("verifies a recovery token and honors next=/reset-password", async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    await GET(
      makeReq(
        "http://localhost/auth/confirm?token_hash=abc&type=recovery&next=/reset-password"
      )
    );
    expect(mockVerifyOtp).toHaveBeenCalledWith({
      type: "recovery",
      token_hash: "abc",
    });
    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("http://localhost/reset-password")
    );
  });

  it("rejects a non-allowlisted `type` without calling verifyOtp", async () => {
    await GET(
      makeReq("http://localhost/auth/confirm?token_hash=abc&type=magiclink")
    );
    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("http://localhost/sign-in?error=confirm")
    );
  });

  it("returns a generic 429 over the per-IP limit, before verifying", async () => {
    mockCheckLimit.mockResolvedValueOnce(true);
    const res = await GET(
      makeReq("http://localhost/auth/confirm?token_hash=abc&type=email")
    );
    expect(res).toEqual({
      body: "Too many requests. Please try again later.",
      status: 429,
    });
    expect(mockCheckLimit).toHaveBeenCalledWith("authConfirm", "ip", "203.0.113.7");
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it("returns the pre-built redirect so session cookies travel with it", async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    const result = await GET(
      makeReq("http://localhost/auth/confirm?token_hash=abc&type=email")
    );
    // The route must return the response built before verifyOtp() is called so
    // that any cookies setAll() writes onto it are present in the response.
    expect(result).toBe(mockRedirect.mock.results[0].value);
  });
});
