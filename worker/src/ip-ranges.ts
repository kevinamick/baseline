// IPv4 / IPv6 private-and-reserved address classification, shared by the two SSRF
// defenses on Connection endpoints:
//   - the worker's fetch-time egress guard (safe-fetch.ts), which resolves a hostname
//     and must refuse to connect to any private/reserved resolved address, and
//   - the app's save-time validator (src/lib/connections/endpoint.ts, #220), which
//     rejects an endpoint whose hostname is *literally* a private/reserved IP before it
//     is ever stored.
//
// The two consumers live in separate TypeScript projects (the app excludes `worker/`
// from its tsconfig, and the worker ships to Fly with only `worker/src` in its Docker
// build context). To keep the range logic single-sourced rather than mirrored, this file
// is the one copy: the worker imports it directly, and the app reaches across into
// `worker/src/ip-ranges` for the same functions. The app's tsconfig `target` is ES2020 so
// the BigInt literals below typecheck on both sides.
//
// This file is intentionally dependency-free (pure functions, no imports) so either
// project can compile it under its own module/target settings.

// ---------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------

function ipv4ToInt(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function inV4Cidr(ip: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (baseInt & mask);
}

function isBlockedV4(ip: number): boolean {
  return (
    inV4Cidr(ip, "0.0.0.0", 8) || // "this" network / unspecified
    inV4Cidr(ip, "10.0.0.0", 8) || // RFC1918 private
    inV4Cidr(ip, "100.64.0.0", 10) || // CGNAT (RFC6598)
    inV4Cidr(ip, "127.0.0.0", 8) || // loopback
    inV4Cidr(ip, "169.254.0.0", 16) || // link-local, incl. 169.254.169.254 cloud metadata
    inV4Cidr(ip, "172.16.0.0", 12) || // RFC1918 private
    inV4Cidr(ip, "192.0.0.0", 24) || // IETF protocol assignments
    inV4Cidr(ip, "192.168.0.0", 16) || // RFC1918 private
    inV4Cidr(ip, "198.18.0.0", 15) || // benchmarking (RFC2544)
    inV4Cidr(ip, "224.0.0.0", 4) || // multicast
    inV4Cidr(ip, "240.0.0.0", 4) // reserved, incl. 255.255.255.255 broadcast
  );
}

// ---------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------

// Parse an IPv6 literal (with optional zone id and embedded IPv4) to a 128-bit BigInt.
// Returns null if it is not a well-formed IPv6 address.
function ipv6ToBigInt(input: string): bigint | null {
  let addr = input.split("%")[0]; // drop zone id (fe80::1%eth0)

  // Embedded IPv4 in the last group (::ffff:1.2.3.4, 64:ff9b::1.2.3.4, ::1.2.3.4).
  if (addr.includes(".")) {
    const lastColon = addr.lastIndexOf(":");
    if (lastColon === -1) return null;
    const v4 = ipv4ToInt(addr.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : null;

  let groups: string[];
  if (tail === null) {
    groups = head; // no "::" → must be a full 8-group address
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;

  let result = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    result = (result << 16n) | BigInt(parseInt(g, 16));
  }
  return result;
}

function inV6Cidr(ip: bigint, base: bigint, bits: number): boolean {
  const mask = bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
  return (ip & mask) === (base & mask);
}

const V6_ULA = ipv6ToBigInt("fc00::")!; // /7
const V6_LINK_LOCAL = ipv6ToBigInt("fe80::")!; // /10
const V6_MULTICAST = ipv6ToBigInt("ff00::")!; // /8
const V6_NAT64 = ipv6ToBigInt("64:ff9b::")!; // /96 well-known NAT64 prefix

function isBlockedV6(ip: bigint): boolean {
  // IPv4-mapped (::ffff:0:0/96): unwrap and apply the IPv4 rules so e.g.
  // ::ffff:169.254.169.254 is blocked.
  if (ip >> 32n === 0xffffn) {
    return isBlockedV4(Number(ip & 0xffffffffn));
  }
  // Anything with the top 96 bits zero (::/96): the unspecified address (::), loopback (::1),
  // and the deprecated IPv4-compatible form (::a.b.c.d). Unwrap the low 32 bits and apply the
  // IPv4 rules so e.g. ::127.0.0.1 / ::169.254.169.254 can't slip past as "public" IPv6.
  // (0.0.0.0/8 covers :: and ::1.) IPv4-compatible addressing is deprecated, so blocking the
  // whole range is the fail-closed choice.
  if (ip >> 32n === 0n) {
    return isBlockedV4(Number(ip & 0xffffffffn));
  }
  // NAT64 (64:ff9b::/96) could route to an internal target via translation — block the whole
  // prefix regardless of the embedded address.
  if (inV6Cidr(ip, V6_NAT64, 96)) return true;

  return (
    inV6Cidr(ip, V6_ULA, 7) ||
    inV6Cidr(ip, V6_LINK_LOCAL, 10) ||
    inV6Cidr(ip, V6_MULTICAST, 8)
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// True if `ip` is a private / reserved / otherwise non-public address we must never connect
// to. Fails closed: an address we cannot parse is treated as blocked. Used by the worker's
// egress guard on each DNS-resolved address (where the input is always a real IP, so a
// parse failure is a genuine anomaly and blocking is correct).
export function isBlockedAddress(ip: string): boolean {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) return isBlockedV4(v4);
  const v6 = ipv6ToBigInt(ip);
  if (v6 !== null) return isBlockedV6(v6);
  return true;
}

// True if `host` is an IP *literal* (v4 or v6, surrounding IPv6 brackets tolerated) that
// falls in a private/reserved range. Used by the app's save-time validator on a URL's
// hostname. Unlike isBlockedAddress this fails OPEN for a non-IP-literal input: a DNS
// hostname returns false, because resolving it (and catching a rebind to a private address)
// is the fetch-time guard's job, not this best-effort save-time gate. A public IP literal
// (e.g. 1.1.1.1) also returns false — only private/reserved literals are rejected here.
export function isBlockedIpLiteral(host: string): boolean {
  const h = host.replace(/^\[/, "").replace(/\]$/, ""); // strip IPv6 brackets
  const v4 = ipv4ToInt(h);
  if (v4 !== null) return isBlockedV4(v4);
  const v6 = ipv6ToBigInt(h);
  if (v6 !== null) return isBlockedV6(v6);
  return false; // not an IP literal → defer to the fetch-time guard
}
