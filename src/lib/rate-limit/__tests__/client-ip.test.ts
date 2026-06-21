import { describe, it, expect, vi } from "vitest";

// client-ip.ts imports next/headers at module load; stub it (we test the pure helpers).
vi.mock("next/headers", () => ({ headers: vi.fn() }));

import { clientIpFromHeaders, normalizeIp } from "../client-ip";

function withHeaders(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("clientIpFromHeaders", () => {
  it("reads the platform-injected x-vercel-forwarded-for", () => {
    expect(
      clientIpFromHeaders(withHeaders({ "x-vercel-forwarded-for": "203.0.113.7" }))
    ).toBe("203.0.113.7");
  });

  it("ignores a spoofed client x-forwarded-for / x-real-ip", () => {
    // An attacker controls these; trusting them would mint a fresh bucket per
    // request. With no trusted header present we fall back to the sentinel.
    const h = withHeaders({
      "x-forwarded-for": "1.2.3.4",
      "x-real-ip": "5.6.7.8",
    });
    expect(clientIpFromHeaders(h)).toBe("0.0.0.0");
  });

  it("trusts the platform header even when a spoofed one is also present", () => {
    const h = withHeaders({
      "x-vercel-forwarded-for": "203.0.113.7",
      "x-forwarded-for": "1.2.3.4",
    });
    expect(clientIpFromHeaders(h)).toBe("203.0.113.7");
  });

  it("takes the left-most (client) IP if the trusted header is a list", () => {
    expect(
      clientIpFromHeaders(
        withHeaders({ "x-vercel-forwarded-for": "203.0.113.7, 70.0.0.1" })
      )
    ).toBe("203.0.113.7");
  });

  it("falls back to a sentinel off-platform (header absent)", () => {
    expect(clientIpFromHeaders(withHeaders({}))).toBe("0.0.0.0");
  });
});

describe("normalizeIp", () => {
  it("keys IPv4 on the full address", () => {
    expect(normalizeIp("203.0.113.7")).toBe("203.0.113.7");
  });

  it("keys IPv6 on the /64 prefix (full form)", () => {
    expect(normalizeIp("2001:0db8:85a3:1111:2222:3333:4444:5555")).toBe(
      "2001:0db8:85a3:1111::/64"
    );
  });

  it("collapses every address in the same /64 to one bucket", () => {
    const a = normalizeIp("2001:db8:85a3:1111::1");
    const b = normalizeIp("2001:db8:85a3:1111:ffff:ffff:ffff:ffff");
    expect(a).toBe(b);
    expect(a).toBe("2001:0db8:85a3:1111::/64");
  });

  it("expands the :: shorthand correctly", () => {
    expect(normalizeIp("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(normalizeIp("::1")).toBe("0000:0000:0000:0000::/64");
  });

  it("strips an IPv6 zone id", () => {
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80:0000:0000:0000::/64");
  });

  it("keys an IPv4-mapped IPv6 address as its IPv4 (not the all-zeros /64)", () => {
    expect(normalizeIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeIp("::ffff:203.0.113.7")).not.toBe(normalizeIp("::1"));
  });
});
