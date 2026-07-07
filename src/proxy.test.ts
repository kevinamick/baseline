import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: these are referenced inside vi.mock factories, which are hoisted
// above the static `import { proxy }` below.
const { mockUpdateSession, mockNext, mockRedirect, mockRewrite, mockIntl } =
  vi.hoisted(() => ({
    mockUpdateSession: vi.fn(),
    mockNext: vi.fn(),
    mockRedirect: vi.fn(),
    mockRewrite: vi.fn(),
    mockIntl: vi.fn(),
  }));
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: mockUpdateSession,
}));
vi.mock("next/server", () => ({
  NextResponse: {
    next: mockNext,
    redirect: mockRedirect,
    rewrite: mockRewrite,
  },
}));
// next-intl's middleware imports `next/server` internally; mock the factory so we
// drive its decision (pass-through / redirect / rewrite) per test.
vi.mock("next-intl/middleware", () => ({ default: () => mockIntl }));

import { proxy } from "./proxy";

function makeReq(pathname: string) {
  return {
    url: `http://localhost${pathname}`,
    nextUrl: { pathname },
    headers: new Headers(),
  } as unknown as Parameters<typeof proxy>[0];
}

// Response from updateSession carries the rotated Supabase cookies.
function makeResp(cookies: { name: string; value: string }[] = []) {
  return {
    headers: { set: vi.fn() },
    cookies: { getAll: () => cookies },
  };
}

function makeRedirect() {
  return { headers: { set: vi.fn() }, cookies: { set: vi.fn() } };
}

// next-intl middleware results, modeled by the response headers proxy reads.
function intlPass(cookies: { name: string; value: string }[] = []) {
  return {
    headers: { get: () => null, set: vi.fn() },
    cookies: { getAll: () => cookies },
  };
}
function intlRedirect(location: string) {
  return {
    headers: {
      get: (k: string) => (k === "location" ? location : null),
      set: vi.fn(),
    },
    cookies: { getAll: () => [] },
  };
}
function intlRewrite(
  rewriteUrl: string,
  cookies: { name: string; value: string }[] = []
) {
  return {
    headers: {
      get: (k: string) => (k === "x-middleware-rewrite" ? rewriteUrl : null),
      set: vi.fn(),
    },
    cookies: { getAll: () => cookies },
  };
}

describe("proxy — auth gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: locale routing is a no-op pass-through.
    mockIntl.mockReturnValue(intlPass());
  });

  it("redirects unauthenticated requests on protected routes to /sign-in", async () => {
    mockRedirect.mockReturnValue(makeRedirect());
    mockUpdateSession.mockResolvedValue({ user: null, response: makeResp() });
    await proxy(makeReq("/rubrics"));
    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("/sign-in", "http://localhost/rubrics")
    );
  });

  it("carries the rotated session cookies and request id onto the sign-in redirect", async () => {
    const redirect = makeRedirect();
    mockRedirect.mockReturnValue(redirect);
    const cookies = [{ name: "sb-access-token", value: "rotated" }];
    mockUpdateSession.mockResolvedValue({
      user: null,
      response: makeResp(cookies),
    });

    const result = await proxy(makeReq("/rubrics"));

    expect(redirect.cookies.set).toHaveBeenCalledWith(cookies[0]);
    expect(redirect.headers.set).toHaveBeenCalledWith(
      "x-request-id",
      expect.any(String)
    );
    expect(result).toBe(redirect);
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

  it.each(["/sign-in", "/sign-up", "/forgot-password"])(
    "redirects an authenticated user on auth route %s to /dashboard (#356)",
    async (path) => {
      mockRedirect.mockReturnValue(makeRedirect());
      mockUpdateSession.mockResolvedValue({ user: { id: "u" }, response: makeResp() });
      await proxy(makeReq(path));
      expect(mockRedirect).toHaveBeenCalledWith(
        new URL("/dashboard", `http://localhost${path}`)
      );
    }
  );

  it("redirects an authenticated user on a locale-prefixed sign-in to that locale's dashboard (#356)", async () => {
    mockRedirect.mockReturnValue(makeRedirect());
    mockUpdateSession.mockResolvedValue({ user: { id: "u" }, response: makeResp() });
    await proxy(makeReq("/es/sign-in"));
    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("/es/dashboard", "http://localhost/es/sign-in")
    );
  });

  it("does not redirect an authenticated user on the root landing page (#356)", async () => {
    const response = makeResp();
    mockUpdateSession.mockResolvedValue({ user: { id: "u" }, response });
    await proxy(makeReq("/"));
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("does not redirect an authenticated user on /auth/confirm (#356 — token routes must process)", async () => {
    const response = makeResp();
    mockUpdateSession.mockResolvedValue({ user: { id: "u" }, response });
    await proxy(makeReq("/auth/confirm?token_hash=abc&type=email"));
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it.each([
    "/",
    "/sign-in",
    "/sign-up",
    "/pricing",
    "/auth/confirm",
    "/invite/accept",
    "/api/webhooks/stripe",
    // Marketing/SEO surface (ADR-0013) — reachable signed-out by crawlers/prospects.
    "/compare/braintrust",
    "/llm-evaluation",
    "/llm-as-judge",
    "/prompt-optimization",
    "/rubric-based-evaluation",
    // The /docs resources index (#306) is part of the public marketing surface.
    "/docs",
    // The colocated OG image route must stay public too (else social/crawler
    // fetches of og:image bounce to sign-in) — guards the #278 proxy tail.
    "/llm-evaluation/opengraph-image",
    // The /blog narrative-content surface (#435) is public marketing/SEO surface.
    "/blog",
    "/blog/optimizer-prompt-dogfood",
    "/blog/opengraph-image",
    "/blog/optimizer-prompt-dogfood/opengraph-image",
  ])(
    "does not redirect on public route %s even when unauthenticated",
    async (path) => {
      mockUpdateSession.mockResolvedValue({ user: null, response: makeResp() });
      await proxy(makeReq(path));
      expect(mockRedirect).not.toHaveBeenCalled();
    }
  );

  it("protects the deleted Clerk webhook path (no longer public)", async () => {
    mockRedirect.mockReturnValue(makeRedirect());
    mockUpdateSession.mockResolvedValue({ user: null, response: makeResp() });
    await proxy(makeReq("/api/webhooks/clerk"));
    expect(mockRedirect).toHaveBeenCalled();
  });

  it("preserves an incoming x-request-id header", async () => {
    const response = makeResp();
    mockUpdateSession.mockResolvedValue({ user: { id: "u" }, response });
    const req = makeReq("/rubrics");
    req.headers.set("x-request-id", "fixed-id");
    await proxy(req);
    expect(response.headers.set).toHaveBeenCalledWith("x-request-id", "fixed-id");
  });
});

describe("proxy — locale routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIntl.mockReturnValue(intlPass());
  });

  it("short-circuits a locale-detection redirect, tagging it with the CSP", async () => {
    const redirectResp = intlRedirect("http://localhost/es");
    mockIntl.mockReturnValue(redirectResp);
    mockUpdateSession.mockResolvedValue({ user: null, response: makeResp() });

    const result = await proxy(makeReq("/"));

    expect(result).toBe(redirectResp);
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(redirectResp.headers.set).toHaveBeenCalledWith(
      "content-security-policy",
      expect.any(String)
    );
  });

  it("re-issues next-intl's rewrite and merges both responses' cookies", async () => {
    const intlCookie = { name: "NEXT_LOCALE", value: "es" };
    const sessionCookie = { name: "sb-access-token", value: "rotated" };
    mockIntl.mockReturnValue(intlRewrite("http://localhost/es/pricing", [intlCookie]));
    mockUpdateSession.mockResolvedValue({
      user: { id: "u" },
      response: makeResp([sessionCookie]),
    });
    const rewritten = { headers: { set: vi.fn() }, cookies: { set: vi.fn() } };
    mockRewrite.mockReturnValue(rewritten);

    const result = await proxy(makeReq("/es/pricing"));

    expect(mockRewrite).toHaveBeenCalledWith(
      new URL("http://localhost/es/pricing"),
      { request: { headers: expect.any(Headers) } }
    );
    expect(rewritten.cookies.set).toHaveBeenCalledWith(intlCookie);
    expect(rewritten.cookies.set).toHaveBeenCalledWith(sessionCookie);
    expect(result).toBe(rewritten);
  });

  it("redirects an unauthenticated prefixed route to that locale's sign-in", async () => {
    mockRedirect.mockReturnValue(makeRedirect());
    mockUpdateSession.mockResolvedValue({ user: null, response: makeResp() });

    await proxy(makeReq("/es/rubrics"));

    expect(mockRedirect).toHaveBeenCalledWith(
      new URL("/es/sign-in", "http://localhost/es/rubrics")
    );
  });

  it("does not locale-route API paths", async () => {
    mockUpdateSession.mockResolvedValue({ user: { id: "u" }, response: makeResp() });
    await proxy(makeReq("/api/internal/retention"));
    expect(mockIntl).not.toHaveBeenCalled();
  });
});
