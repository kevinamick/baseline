import { headers } from "next/headers";

// Trusted client IP for IP-keyed rate limits (#209, ADR-0010).
//
// We read ONLY `x-vercel-forwarded-for`, which Vercel's edge sets to the real
// client IP and a client cannot forge. We deliberately ignore the standard
// `x-forwarded-for` / `x-real-ip`: those are client-supplied and trivially
// spoofable, so honoring them would let an attacker mint a fresh limit bucket
// per request. Off-platform (local dev, tests) the header is absent and we fall
// back to a fixed sentinel — everyone shares one bucket, which is fine since the
// limiter is off in e2e and local volume is trivial.
const TRUSTED_HEADER = "x-vercel-forwarded-for";
const FALLBACK_IP = "0.0.0.0";

/**
 * Reduce a raw IP to its rate-limit key. IPv4 is keyed in full. IPv6 is keyed on
 * the /64 prefix: ISPs routinely hand a single subscriber a whole /64 (or larger),
 * so limiting on the full address would let one host rotate through addresses for
 * free. Returns a stable, fully-expanded prefix string.
 */
export function normalizeIp(raw: string): string {
  const ip = raw.trim();
  if (!ip) return FALLBACK_IP;
  if (!ip.includes(":")) return ip;

  // An IPv4-mapped IPv6 address (::ffff:192.0.2.1) is really an IPv4 client —
  // key it as the full IPv4 so it doesn't collapse into the all-zeros /64 bucket
  // shared with ::1 and other low addresses.
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return mapped[1];

  return ipv6Prefix64(ip);
}

function ipv6Prefix64(addr: string): string {
  // Strip brackets and any zone id (`%eth0`).
  let a = addr.replace(/[[\]]/g, "");
  const zone = a.indexOf("%");
  if (zone !== -1) a = a.slice(0, zone);

  // Expand the `::` shorthand to a full 8-group address, then take the first 4.
  const [headPart, tailPart] = a.split("::");
  const head = headPart ? headPart.split(":") : [];
  const tail = tailPart === undefined ? null : tailPart ? tailPart.split(":") : [];

  let groups: string[];
  if (tail === null) {
    groups = head; // no `::` — already full (or malformed; padded below)
  } else {
    const missing = Math.max(0, 8 - head.length - tail.length);
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  }

  const prefix = Array.from({ length: 4 }, (_, i) => {
    const g = groups[i];
    return (g && g !== "" ? g : "0").toLowerCase().padStart(4, "0");
  });
  return prefix.join(":") + "::/64";
}

/**
 * Pull the trusted client IP out of an arbitrary Headers (pure, so it can be
 * unit-tested with spoof attempts). The trusted header is normally a single IP;
 * if a list ever appears we take the first (left-most = client).
 */
export function clientIpFromHeaders(h: Headers): string {
  const raw = h.get(TRUSTED_HEADER);
  if (!raw) return FALLBACK_IP;
  const first = raw.split(",")[0];
  return normalizeIp(first);
}

/** The trusted client IP for the current request (server action / route handler). */
export async function trustedClientIp(): Promise<string> {
  return clientIpFromHeaders(await headers());
}
