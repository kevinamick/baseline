import { describe, it, expect, vi, beforeEach } from "vitest";

// `import "server-only"` in post-auth-redirect.ts throws outside a server bundle.
vi.mock("server-only", () => ({}));

// vi.hoisted: referenced inside the hoisted vi.mock factories below.
const {
  mockExchangeCodeForSession,
  mockGetUser,
  mockRedirect,
  mockCheckLimit,
  mockSelectEq,
} = vi.hoisted(() => ({
  mockExchangeCodeForSession: vi.fn(),
  mockGetUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
  mockRedirect: vi.fn((url: URL) => ({ redirectedTo: url })),
  mockCheckLimit: vi.fn(async () => false),
  mockSelectEq: vi.fn(),
}));

vi.mock("@/lib/supabase/route-client", () => ({
  createRouteClient: vi.fn(() => ({
    auth: {
      exchangeCodeForSession: mockExchangeCodeForSession,
      getUser: mockGetUser,
    },
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: vi.fn(() => ({ select: () => ({ eq: mockSelectEq }) })) },
}));

vi.mock("next/server", () => {
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

describe("GET /auth/callback", () => {
  it("exchanges the code and redirects to /dashboard when the user has an org", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
    memberships([{ org_id: "org-1" }]);
    await GET(makeReq("http://localhost/auth/callback?code=abc"));
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("http://localhost/dashboard")
    );
  });

  it("redirects to /onboarding when the user has no org membership (#355)", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
    memberships([]);
    await GET(makeReq("http://localhost/auth/callback?code=abc"));
    expect(mockRedirect).toHaveBeenLastCalledWith(
      new URL("http://localhost/onboarding")
    );
  });

  it("honors a relative `next` path when the user has an org", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
    memberships([{ org_id: "org-1" }]);
    await GET(makeReq("http://localhost/auth/callback?code=abc&next=/rubrics"));
    expect(mockRedirect).toHaveBeenCalledWith(new URL("http://localhost/rubrics"));
  });

  it("ignores an off-site `next` and falls back to /dashboard", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
    memberships([{ org_id: "org-1" }]);
    await GET(
      makeReq(
        `http://localhost/auth/callback?code=abc&next=${encodeURIComponent("https://evil.com")}`
      )
    );
    expect(mockRedirect).toHaveBeenLastCalledWith(
      new URL("http://localhost/dashboard")
    );
  });

  it("redirects to sign-in when the exchange fails", async () => {
    mockExchangeCodeForSession.mockResolvedValue({
      error: { message: "bad code" },
    });
    await GET(makeReq("http://localhost/auth/callback?code=abc"));
    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("http://localhost/sign-in?error=oauth")
    );
  });

  it("redirects to sign-in when the code is missing", async () => {
    await GET(makeReq("http://localhost/auth/callback"));
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("http://localhost/sign-in?error=oauth")
    );
  });

  it("returns a generic 429 over the per-IP limit, before exchanging", async () => {
    mockCheckLimit.mockResolvedValueOnce(true);
    const res = await GET(makeReq("http://localhost/auth/callback?code=abc"));
    expect(res).toEqual({
      body: "Too many requests. Please try again later.",
      status: 429,
    });
    expect(mockCheckLimit).toHaveBeenCalledWith("authCallback", "ip", "203.0.113.7");
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });
});
