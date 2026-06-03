import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: referenced inside the hoisted vi.mock factories below.
const { mockVerifyOtp, mockRedirect } = vi.hoisted(() => ({
  mockVerifyOtp: vi.fn(),
  mockRedirect: vi.fn((url: URL) => ({ redirectedTo: url })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { verifyOtp: mockVerifyOtp } })),
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
});
