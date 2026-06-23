// Save-time validation for a Connection endpoint URL (#220). This is the first, best-effort
// SSRF gate: it rejects endpoints that are *obviously* internal before they are ever stored,
// and gives the user a clear reason. It is NOT the last line of defense — a hostname that
// looks public here can still resolve to a private address later (DNS rebinding), which is
// why the worker re-validates every resolved address at fetch time (worker/src/safe-fetch.ts).
//
// The private/reserved IP-range classification and port allowlist are shared with that worker
// guard rather than duplicated: both import them from worker/src/ip-ranges.ts (#220, #314).
// The app's tsconfig `target` is ES2020 so the BigInt literals typecheck on this side too.
import { isBlockedIpLiteral, isBlockedPort } from "../../../worker/src/ip-ranges";

export const ENDPOINT_HTTPS_MESSAGE = "Endpoint must use HTTPS";
export const ENDPOINT_USERINFO_MESSAGE =
  "Endpoint must not embed a username or password";
export const ENDPOINT_INTERNAL_MESSAGE =
  "Endpoint must be a public address — localhost, .local/.internal, and private or reserved IP addresses are not allowed";
export const ENDPOINT_PORT_MESSAGE =
  "Endpoint port must be standard (443 for HTTPS, 80 for HTTP)";

// Hostnames that always denote a loopback/internal target regardless of DNS.
// `.localhost` and `.local` are reserved (RFC 6761 / mDNS); `.internal` is the de-facto
// internal TLD on several clouds (e.g. GCP). The bare `localhost` is matched separately.
const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".internal"];

// True when the URL's hostname is an obviously-internal name or a private/reserved IP literal.
// `hostname` comes from the WHATWG URL parser, which lowercases names, canonicalizes IPv4
// literals (octal/hex/decimal → dotted decimal), and brackets IPv6 literals.
function isInternalHost(hostname: string): boolean {
  // A fully-qualified name may carry a trailing dot ("localhost.") that resolves to the same
  // host; normalize it away so the name match can't be bypassed. (IP literals are already
  // canonicalized by the URL parser, trailing dot included.)
  const host = hostname.replace(/\.+$/, "");
  if (host === "localhost") return true;
  if (INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return isBlockedIpLiteral(host);
}

// Returns null when `raw` is an acceptable Connection endpoint, otherwise a human-readable
// reason it was rejected. process.env.NODE_ENV is available at runtime on the server (zod
// path) and inlined at build time on the client (wizard), so both agree on the http rule.
export function endpointUrlError(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "Enter a valid URL (https://…)";
  }
  // https is required in production so the credential is encrypted in flight; http is
  // permitted only in development/tests so local testing against a mock agent works.
  if (url.protocol === "http:") {
    if (process.env.NODE_ENV !== "development") return ENDPOINT_HTTPS_MESSAGE;
  } else if (url.protocol !== "https:") {
    return ENDPOINT_HTTPS_MESSAGE;
  }
  // Credentials in the URL would be sent to the (attacker-chosen) host and bypass the
  // auth-header model; refuse them outright.
  if (url.username !== "" || url.password !== "") return ENDPOINT_USERINFO_MESSAGE;
  if (isInternalHost(url.hostname)) return ENDPOINT_INTERNAL_MESSAGE;
  if (isBlockedPort(url.port, url.protocol)) return ENDPOINT_PORT_MESSAGE;
  return null;
}

export function isAllowedEndpointUrl(raw: string): boolean {
  return endpointUrlError(raw) === null;
}
