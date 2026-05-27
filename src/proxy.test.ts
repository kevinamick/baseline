import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// vi.hoisted ensures this object is available inside vi.mock factory closures.
const holder = vi.hoisted(() => ({
  handler: null as ((auth: unknown, req: unknown) => Promise<unknown>) | null,
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: vi.fn((fn: (auth: unknown, req: unknown) => Promise<unknown>) => {
    holder.handler = fn;
    return fn;
  }),
  // Simplified route matcher: strip capture groups, then match exactly or as a prefix.
  // "/" is treated as exact-only so it doesn't swallow every pathname.
  createRouteMatcher: (patterns: string[]) => (req: { url: string }) => {
    const { pathname } = new URL(req.url);
    return patterns.some((p) => {
      const stem = p.replace(/\(.*?\)/g, "").replace(/\/$/, "") || "/";
      if (stem === "/") return pathname === "/";
      return pathname === stem || pathname.startsWith(stem + "/");
    });
  },
}));

const mockNext = vi.fn();
const mockRedirect = vi.fn();

vi.mock("next/server", () => ({
  NextResponse: {
    next: mockNext,
    redirect: mockRedirect,
  },
}));

// Load proxy.ts so clerkMiddleware is called and holder.handler is populated.
beforeAll(async () => {
  await import("./proxy");
});

// --- Helpers ---

function makeAuth(userId: string | null, orgId: string | null) {
  const fn = vi.fn().mockResolvedValue({ userId, orgId });
  (fn as unknown as { protect: ReturnType<typeof vi.fn> }).protect = vi.fn().mockResolvedValue(undefined);
  return fn;
}

function makeReq(pathname: string) {
  const url = `http://localhost${pathname}`;
  return {
    url,
    // Use a real Headers instance — proxy calls `new Headers(req.headers)` to copy headers.
    headers: new Headers(),
  };
}

// --- Tests ---

describe("proxy — org gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNext.mockReturnValue({ headers: { set: vi.fn(), get: vi.fn(() => null) } });
    mockRedirect.mockReturnValue({ type: "redirect" });
  });

  it("redirects to /onboarding when authenticated user has no active org", async () => {
    const auth = makeAuth("user_123", null);
    await holder.handler!(auth, makeReq("/rubrics"));
    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("/onboarding", "http://localhost/rubrics")
    );
  });

  it("does not redirect when user has an active orgId", async () => {
    const auth = makeAuth("user_123", "org_abc");
    await holder.handler!(auth, makeReq("/rubrics"));
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockNext).toHaveBeenCalled();
  });

  it("does not redirect on /onboarding even without an orgId", async () => {
    const auth = makeAuth("user_123", null);
    await holder.handler!(auth, makeReq("/onboarding"));
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("does not redirect on /onboarding sub-paths", async () => {
    const auth = makeAuth("user_123", null);
    await holder.handler!(auth, makeReq("/onboarding/step-2"));
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it.each(["/", "/sign-in", "/sign-up", "/api/webhooks/clerk"])(
    "does not redirect on public route %s",
    async (path) => {
      const auth = makeAuth("user_123", null);
      await holder.handler!(auth, makeReq(path));
      expect(mockRedirect).not.toHaveBeenCalled();
    }
  );

  it("does not redirect unauthenticated users (auth.protect handles them)", async () => {
    const auth = makeAuth(null, null);
    await holder.handler!(auth, makeReq("/rubrics"));
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
