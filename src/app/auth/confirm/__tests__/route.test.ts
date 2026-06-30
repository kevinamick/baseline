import { describe, it, expect, vi, beforeEach } from "vitest";

// `import "server-only"` in post-auth-redirect.ts throws outside a server bundle.
vi.mock("server-only", () => ({}));

// vi.hoisted: referenced inside the hoisted vi.mock factories below.
const { mockVerifyOtp, mockGetUser, mockRedirect, mockCheckLimit, mockSelectEq } =
  vi.hoisted(() => ({
    mockVerifyOtp: vi.fn(),
    mockGetUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
    mockRedirect: vi.fn((url: URL) => ({
      redirectedTo: url,
      cookies: { getAll: () => [{ name: "sb-access-token", value: "session" }], set: vi.fn() },
    })),
    mockCheckLimit: vi.fn(async () => false),
    // The membership query builder — a chainable object whose `limit()`
    // resolves to { data: [...], error: null }. Seeded per-test via mockSelectEq.
    mockSelectEq: vi.fn(),
  }));

// The route-client factory returns a Supabase client backed by request/response
// cookies. We mock it so the route handler's two createRouteClient calls share
// one client (verifyOtp + getUser), as they would in production (the request
// cookies carry the session).
vi.mock("@/lib/supabase/route-client", () => ({
  createRouteClient: vi.fn(() => ({
    auth: { verifyOtp: mockVerifyOtp, getUser: mockGetUser },
  })),
}));

// supabaseAdmin is used for the membership check (#355 onboarding redirect).
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: vi.fn(() => ({ select: () => ({ eq: mockSelectEq }) })) },
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

// Seed the membership query result. Returns the chainable builder so the
// route handler's `.select("org_id").eq("user_id", …).limit(1)` resolves.
function memberships(rows: unknown[]) {
  mockSelectEq.mockReturnValue({
    limit: vi.fn(async () => ({ data: rows, error: null })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckLimit.mockReset().mockResolvedValue(false);
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: "user-1" } } });
  memberships([]); // default: no org → onboarding
});

describe("GET /auth/confirm", () => {
  it("verifies the token and redirects to /dashboard when the user has an org", async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    memberships([{ org_id: "org-1" }]);
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

  it("redirects to /onboarding when the user has no org membership (#355)", async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    memberships([]); // no org
    const result = await GET(
      makeReq("http://localhost/auth/confirm?token_hash=abc&type=email")
    );
    // First redirect call is the initial NextResponse.redirect(next) response
    // object; the onboarding redirect is the second call.
    expect(mockRedirect).toHaveBeenLastCalledWith(
      new URL("http://localhost/onboarding")
    );
    // Session cookies from the initial response are copied onto the onboarding
    // redirect so the session survives the second redirect (#354).
    expect(result.cookies.set).toHaveBeenCalledWith({
      name: "sb-access-token",
      value: "session",
    });
  });

  it("honors a relative `next` path on success when the user has an org", async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    memberships([{ org_id: "org-1" }]);
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
    memberships([{ org_id: "org-1" }]);
    await GET(
      makeReq(
        `http://localhost/auth/confirm?token_hash=abc&type=email&next=${encodeURIComponent(next)}`
      )
    );
    // First redirect is the initial response; final redirect to /dashboard.
    expect(mockRedirect).toHaveBeenLastCalledWith(
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

  it("verifies a recovery token and honors next=/reset-password (skips onboarding check)", async () => {
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
    // Recovery flows return the initial redirect response (to /reset-password)
    // without checking onboarding — only one redirect call.
    expect(mockRedirect).toHaveBeenCalledTimes(1);
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
});
