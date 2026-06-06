import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: referenced inside the hoisted vi.mock factories below.
const { mockExchangeCodeForSession, mockRedirect } = vi.hoisted(() => ({
  mockExchangeCodeForSession: vi.fn(),
  mockRedirect: vi.fn((url: URL) => ({ redirectedTo: url })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { exchangeCodeForSession: mockExchangeCodeForSession },
  })),
}));
vi.mock("next/server", () => ({
  NextResponse: { redirect: mockRedirect },
}));

import { GET } from "../route";

function makeReq(url: string) {
  return { url } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
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
});
