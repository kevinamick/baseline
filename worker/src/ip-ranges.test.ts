import { describe, it, expect } from "vitest";
import {
  isBlockedAddress,
  isBlockedIpLiteral,
  isBlockedPort,
} from "./ip-ranges.js";

describe("isBlockedAddress", () => {
  const blocked = [
    // IPv4 private / reserved
    ["loopback", "127.0.0.1"],
    ["loopback (other)", "127.255.255.254"],
    ["RFC1918 10/8", "10.1.2.3"],
    ["RFC1918 172.16/12", "172.16.5.5"],
    ["RFC1918 172.31 edge", "172.31.255.255"],
    ["RFC1918 192.168/16", "192.168.1.1"],
    ["link-local", "169.254.10.10"],
    ["cloud metadata", "169.254.169.254"],
    ["CGNAT 100.64/10", "100.64.0.1"],
    ["unspecified", "0.0.0.0"],
    ["broadcast", "255.255.255.255"],
    ["multicast", "224.0.0.1"],
    ["benchmarking", "198.18.0.1"],
    // IPv6 private / reserved
    ["v6 loopback", "::1"],
    ["v6 unspecified", "::"],
    ["v6 ULA", "fc00::1"],
    ["v6 ULA (fd)", "fd12:3456::1"],
    ["v6 link-local", "fe80::1"],
    ["v6 multicast", "ff02::1"],
    ["v4-mapped metadata", "::ffff:169.254.169.254"],
    ["v4-mapped private", "::ffff:10.0.0.1"],
    // Deprecated IPv4-compatible form (::a.b.c.d) — must not slip past as "public" IPv6.
    ["v4-compatible loopback", "::127.0.0.1"],
    ["v4-compatible metadata", "::169.254.169.254"],
    ["v4-compatible private", "::10.0.0.1"],
    ["NAT64 well-known", "64:ff9b::1.2.3.4"],
    ["6to4 loopback", "2002:7f00:1::"], // 2002::/16 wrapping 127.0.0.1
    ["6to4 metadata", "2002:a9fe:a9fe::"], // wrapping 169.254.169.254
    ["unparseable", "not-an-ip"],
    // IPv4 octet out of range: ipv4ToInt returns null, and this isn't valid IPv6 either, so
    // isBlockedAddress fails closed (unparseable, not a public "300.x" address).
    ["out-of-range v4 octet", "300.1.1.1"],
    // Malformed IPv6: an embedded IPv4 suffix that itself doesn't parse (too few octets).
    ["malformed embedded v4 in v6", "::1.2.3"],
    // Malformed IPv6: more than one "::" compression is illegal.
    ["multiple :: compressions", "1::2::3"],
    // Malformed IPv6: head+tail exceed 8 groups even with "::" compression (negative fill).
    ["too many groups with ::", "1:2:3:4:5:6:7:8::9"],
    // Malformed IPv6: a group that isn't 1-4 hex digits.
    ["invalid hex group", "1:2:3:4:5:6:7:zzzz"],
  ] as const;

  for (const [name, ip] of blocked) {
    it(`blocks ${name} (${ip})`, () => expect(isBlockedAddress(ip)).toBe(true));
  }

  const allowed = [
    ["public v4", "1.1.1.1"],
    ["public v4 (8.8.8.8)", "8.8.8.8"],
    ["just outside CGNAT", "100.63.255.255"],
    ["just outside 172.16/12 low", "172.15.255.255"],
    ["just outside 172.16/12 high", "172.32.0.0"],
    ["public v6", "2606:4700:4700::1111"],
    ["v4-mapped public", "::ffff:1.1.1.1"],
    ["6to4 public", "2002:808:808::"], // 2002::/16 wrapping public 8.8.8.8
  ] as const;

  for (const [name, ip] of allowed) {
    it(`allows ${name} (${ip})`, () =>
      expect(isBlockedAddress(ip)).toBe(false));
  }
});

describe("isBlockedIpLiteral", () => {
  // Same range logic as isBlockedAddress, but tolerant of IPv6 brackets and — crucially —
  // fail-OPEN for non-IP-literal inputs (a DNS hostname is the fetch-time guard's problem).
  const blocked = [
    ["loopback", "127.0.0.1"],
    ["RFC1918 private", "10.0.0.1"],
    ["cloud metadata", "169.254.169.254"],
    ["192.168/16", "192.168.1.1"],
    ["unspecified", "0.0.0.0"],
    ["CGNAT", "100.64.0.1"],
    ["bracketed v6 loopback", "[::1]"],
    ["bare v6 loopback", "::1"],
    ["bracketed v4-mapped metadata", "[::ffff:169.254.169.254]"],
    ["v6 ULA", "fc00::1"],
  ] as const;

  for (const [name, host] of blocked) {
    it(`blocks private/reserved literal ${name} (${host})`, () =>
      expect(isBlockedIpLiteral(host)).toBe(true));
  }

  const allowed = [
    // Public IP literals are fine — only private/reserved literals are rejected.
    ["public v4 literal", "1.1.1.1"],
    ["public v6 literal", "2606:4700:4700::1111"],
    ["bracketed public v6", "[2606:4700:4700::1111]"],
    // Non-IP-literal inputs fall through (false): DNS resolution / rebinding is handled at
    // fetch time, and bare names like `localhost` are caught by the endpoint validator's
    // hostname rules, not here.
    ["DNS hostname", "api.example.com"],
    ["localhost name", "localhost"],
    ["internal-looking name", "vault.internal"],
    ["empty", ""],
  ] as const;

  for (const [name, host] of allowed) {
    it(`does not block ${name} (${host})`, () =>
      expect(isBlockedIpLiteral(host)).toBe(false));
  }
});

describe("isBlockedPort (#314)", () => {
  it("allows absent port (scheme default)", () => {
    expect(isBlockedPort("", "https:")).toBe(false);
    expect(isBlockedPort("", "http:")).toBe(false);
  });

  it("allows explicit port 443 for https", () => {
    expect(isBlockedPort("443", "https:")).toBe(false);
  });

  it("allows explicit port 80 for http", () => {
    expect(isBlockedPort("80", "http:")).toBe(false);
  });

  it("blocks non-standard ports for https", () => {
    expect(isBlockedPort("8443", "https:")).toBe(true);
    expect(isBlockedPort("8080", "https:")).toBe(true);
    expect(isBlockedPort("6379", "https:")).toBe(true);
    expect(isBlockedPort("22", "https:")).toBe(true);
    expect(isBlockedPort("80", "https:")).toBe(true); // 80 is not the HTTPS default
  });

  it("blocks non-standard ports for http", () => {
    expect(isBlockedPort("8080", "http:")).toBe(true);
    expect(isBlockedPort("443", "http:")).toBe(true); // 443 is not the HTTP default
    expect(isBlockedPort("3000", "http:")).toBe(true);
  });

  it("blocks unknown scheme (fail closed)", () => {
    expect(isBlockedPort("443", "ftp:")).toBe(true);
  });
});
