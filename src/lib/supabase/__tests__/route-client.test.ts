import { describe, it, expect, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Capture the cookies adapter that createRouteClient hands to @supabase/ssr so
// the test can drive `setAll` exactly as `verifyOtp`/`exchangeCodeForSession`
// would when they establish a session.
const { captured } = vi.hoisted(() => ({
  captured: { cookies: null as null | { getAll: () => unknown; setAll: (c: unknown) => void } },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, opts: { cookies: typeof captured.cookies }) => {
    captured.cookies = opts.cookies;
    return { auth: {} };
  },
}));

import { createRouteClient } from "../route-client";

describe("createRouteClient — cookie bridge (#354)", () => {
  it("writes session cookies set during the request onto the redirect response a browser receives", () => {
    // A redirect response — the object the Route Handler returns to the browser.
    const response = NextResponse.redirect(new URL("http://localhost/dashboard"));
    const request = new NextRequest(new URL("http://localhost/auth/confirm?token_hash=abc&type=email"));

    createRouteClient(request, response);
    expect(captured.cookies).not.toBeNull();

    // Simulate Supabase setting the session cookie during verifyOtp/exchange.
    captured.cookies!.setAll([
      {
        name: "sb-access-token",
        value: "the-session",
        options: { path: "/", httpOnly: true },
      },
    ]);

    // The session cookie rides on the redirect response itself — so the browser
    // receives Set-Cookie on the very response that carries the Location header,
    // eliminating the first-click logged-out race (#354).
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("sb-access-token=the-session");
    expect(response.headers.get("location")).toContain("/dashboard");

    // And the request mirror sees it too, so reads later in the same handler
    // (e.g. getUser) observe the freshly-set session.
    expect(request.cookies.get("sb-access-token")?.value).toBe("the-session");
  });
});
