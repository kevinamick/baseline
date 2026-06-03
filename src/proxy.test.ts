import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: these are referenced inside vi.mock factories, which are hoisted
// above the static `import { proxy }` below.
const { mockUpdateSession, mockNext, mockRedirect } = vi.hoisted(() => ({
  mockUpdateSession: vi.fn(),
  mockNext: vi.fn(),
  mockRedirect: vi.fn(),
}));
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: mockUpdateSession,
}));
vi.mock("next/server", () => ({
  NextResponse: { next: mockNext, redirect: mockRedirect },
}));

import { proxy } from "./proxy";

function makeReq(pathname: string) {
  return {
    url: `http://localhost${pathname}`,
    nextUrl: { pathname },
    headers: new Headers(),
  } as unknown as Parameters<typeof proxy>[0];
}

function makeResp() {
  return { headers: { set: vi.fn() } };
}

describe("proxy — auth gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedirect.mockReturnValue({ type: "redirect" });
  });

  it("redirects unauthenticated requests on protected routes to /sign-in", async () => {
    mockUpdateSession.mockResolvedValue({ user: null, response: makeResp() });
    await proxy(makeReq("/rubrics"));
    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("/sign-in", "http://localhost/rubrics")
    );
  });

  it("lets authenticated requests through, tagging the response with a request id", async () => {
    const response = makeResp();
    mockUpdateSession.mockResolvedValue({ user: { id: "u" }, response });
    const result = await proxy(makeReq("/rubrics"));
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(response.headers.set).toHaveBeenCalledWith(
      "x-request-id",
      expect.any(String)
    );
    expect(result).toBe(response);
  });

  it.each(["/", "/sign-in", "/sign-up", "/auth/confirm", "/api/webhooks/clerk"])(
    "does not redirect on public route %s even when unauthenticated",
    async (path) => {
      mockUpdateSession.mockResolvedValue({ user: null, response: makeResp() });
      await proxy(makeReq(path));
      expect(mockRedirect).not.toHaveBeenCalled();
    }
  );

  it("preserves an incoming x-request-id header", async () => {
    const response = makeResp();
    mockUpdateSession.mockResolvedValue({ user: { id: "u" }, response });
    const req = makeReq("/rubrics");
    req.headers.set("x-request-id", "fixed-id");
    await proxy(req);
    expect(response.headers.set).toHaveBeenCalledWith("x-request-id", "fixed-id");
  });
});
