import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCookiesGet = vi.fn();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: mockCookiesGet })),
}));
// `server-only` throws if imported outside a server bundle; stub it for the test env.
vi.mock("server-only", () => ({}));

import { analyticsAllowedOnServer } from "../server";

// Server-side mirror of cookie.ts's analyticsAllowed() (client-side, reads
// document.cookie) — used to gate the GA4 tag (#448) before any HTML with
// the tag reaches the browser.

describe("analyticsAllowedOnServer", () => {
  beforeEach(() => {
    mockCookiesGet.mockReset();
  });

  it("disallows when no consent cookie is present", async () => {
    mockCookiesGet.mockReturnValue(undefined);
    expect(await analyticsAllowedOnServer()).toBe(false);
  });

  it("disallows an unknown/tampered cookie value", async () => {
    mockCookiesGet.mockReturnValue({ value: "maybe" });
    expect(await analyticsAllowedOnServer()).toBe(false);
  });

  it("disallows a rejected choice", async () => {
    mockCookiesGet.mockReturnValue({ value: "rejected" });
    expect(await analyticsAllowedOnServer()).toBe(false);
  });

  it("allows an accepted choice", async () => {
    mockCookiesGet.mockReturnValue({ value: "accepted" });
    expect(await analyticsAllowedOnServer()).toBe(true);
  });
});
