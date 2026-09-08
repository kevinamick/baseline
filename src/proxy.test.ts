import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: these are referenced inside vi.mock factories, which are hoisted
// above the static `import { proxy }` below.
const { mockNext, mockRedirect, mockRewrite, mockIntl } = vi.hoisted(() => ({
  mockNext: vi.fn(),
  mockRedirect: vi.fn(),
  mockRewrite: vi.fn(),
  mockIntl: vi.fn(),
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

function makeReq(pathname: string, headers = new Headers()) {
  return {
    url: `http://localhost${pathname}`,
    nextUrl: { pathname },
    headers,
  } as unknown as Parameters<typeof proxy>[0];
}

function makeResp() {
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

describe("proxy — correlation + CSP (no session gate, ADR-0020)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIntl.mockReturnValue(intlPass());
  });

  it("lets every route through, tagging the response with a request id and CSP", async () => {
    const resp = makeResp();
    mockNext.mockReturnValue(resp);

    const result = await proxy(makeReq("/rubrics"));

    expect(result).toBe(resp);
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(resp.headers.set).toHaveBeenCalledWith("x-request-id", expect.any(String));
    expect(resp.headers.set).toHaveBeenCalledWith(
      "content-security-policy",
      expect.stringContaining("nonce-")
    );
    // The forwarded request carries the nonce so Next can stamp inline scripts.
    const [{ request }] = mockNext.mock.calls[0];
    expect(request.headers.get("x-nonce")).toEqual(expect.any(String));
    expect(request.headers.get("x-request-id")).toEqual(expect.any(String));
  });

  it("always mints a fresh x-request-id, never trusting a spoofed inbound header (#508)", async () => {
    const resp = makeResp();
    mockNext.mockReturnValue(resp);
    const spoofed = "attacker-controlled-id";

    await proxy(makeReq("/rubrics", new Headers({ "x-request-id": spoofed })));

    const [{ request }] = mockNext.mock.calls[0];
    expect(request.headers.get("x-request-id")).not.toBe(spoofed);
    const stamped = resp.headers.set.mock.calls.find(([k]) => k === "x-request-id");
    expect(stamped?.[1]).not.toBe(spoofed);
  });

  it("308s a trailing-slash page URL to its canonical form", async () => {
    const redirectResp = makeResp();
    mockRedirect.mockReturnValue(redirectResp);

    const result = await proxy(makeReq("/rubrics/"));

    expect(mockRedirect).toHaveBeenCalledWith(new URL("http://localhost/rubrics"), 308);
    expect(result).toBe(redirectResp);
    expect(mockIntl).not.toHaveBeenCalled();
  });

  it("leaves the slashed PostHog ingest endpoints alone", async () => {
    const resp = makeResp();
    mockNext.mockReturnValue(resp);

    await proxy(makeReq("/ingest/e/"));

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockIntl).not.toHaveBeenCalled();
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

    const result = await proxy(makeReq("/"));

    expect(result).toBe(redirectResp);
    expect(mockNext).not.toHaveBeenCalled();
    expect(redirectResp.headers.set).toHaveBeenCalledWith(
      "content-security-policy",
      expect.any(String)
    );
  });

  it("re-issues next-intl's rewrite and carries its cookies", async () => {
    const intlCookie = { name: "NEXT_LOCALE", value: "es" };
    mockIntl.mockReturnValue(intlRewrite("http://localhost/es/rubrics", [intlCookie]));
    const rewritten = makeResp();
    mockRewrite.mockReturnValue(rewritten);

    const result = await proxy(makeReq("/es/rubrics"));

    expect(mockRewrite).toHaveBeenCalledWith(
      new URL("http://localhost/es/rubrics"),
      { request: { headers: expect.any(Headers) } }
    );
    expect(rewritten.cookies.set).toHaveBeenCalledWith(intlCookie);
    expect(result).toBe(rewritten);
  });

  it("does not locale-route API paths", async () => {
    mockNext.mockReturnValue(makeResp());
    await proxy(makeReq("/api/internal/retention"));
    expect(mockIntl).not.toHaveBeenCalled();
  });
});
