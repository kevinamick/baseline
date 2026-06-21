import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: referenced inside the hoisted vi.mock factories below.
const { mockExchangeCodeForSession, mockRedirect, mockCheckLimit } = vi.hoisted(
  () => ({
    mockExchangeCodeForSession: vi.fn(),
    mockRedirect: vi.fn((url: URL) => ({ redirectedTo: url })),
    mockCheckLimit: vi.fn(async () => false),
  })
);
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { exchangeCodeForSession: mockExchangeCodeForSession },
  })),
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
  return { url, headers: new Headers() } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckLimit.mockReset().mockResolvedValue(false);
});

describe("GET /auth/callback", () => {
  it("exchanges the code and redirects to /dashboard", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
    await GET(makeReq("http://localhost/auth/callback?code=abc"));
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("http://localhost/dashboard")
    );
  });

  it("honors a relative `next` path on success", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
    await GET(makeReq("http://localhost/auth/callback?code=abc&next=/rubrics"));
    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("http://localhost/rubrics")
    );
  });

  it("ignores an off-site `next` and falls back to /dashboard", async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
    await GET(
      makeReq(
        `http://localhost/auth/callback?code=abc&next=${encodeURIComponent("https://evil.com")}`
      )
    );
    expect(mockRedirect).toHaveBeenCalledWith(
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
