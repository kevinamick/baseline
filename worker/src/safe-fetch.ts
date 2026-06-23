// SSRF egress guard for the worker's outbound fetches to tenant-controlled Connection
// endpoints (#219). A tenant can register a Connection whose `endpoint` is an arbitrary
// URL, and the worker dereferences it server-side from inside our infra — confirmed
// exploitable on staging. Every Connection fetch site (agent invocation, custom dataset
// adapter, posthog adapter) routes through `safeFetch` so the checks happen at FETCH time,
// not just at save time (a hostname that was public when saved can resolve private later).
//
// What it enforces:
//   - http(s) only, no userinfo, https-only in production (mirrors the save-time rule in
//     src/lib/connections/endpoint.ts — the worker is a separate package and mirrors app
//     code rather than importing across the package boundary).
//   - The hostname is resolved and EVERY resolved address must be outside the private /
//     reserved ranges (loopback, RFC1918, link-local incl. 169.254.169.254 metadata, CGNAT,
//     ULA, multicast, unspecified, NAT64, IPv4-mapped IPv6).
//   - The socket is pinned to a validated IP via the `lookup` option, so there is no second
//     DNS resolution between validation and connect — this defeats DNS rebinding (public at
//     resolve, private at connect).
//   - Redirects are refused: a 3xx Location is never followed, so a redirect to an internal
//     address results in no fetch to that address.
//   - Outbound headers are allowlisted (#222): only the header names a call site explicitly
//     names in `allowedHeaders` reach the wire. This is the durable fix for the header-leak
//     vector — it makes it structurally impossible for an adapter, or any future global
//     instrumentation (OTel auto-instrumentation, a telemetry SDK, a fetch wrapper) that injects
//     propagation headers like W3C `traceparent`/`tracestate`/`baggage` or identifying headers
//     (org id, telemetry keys), to ride along on a tenant-bound request. Anything not on the
//     list is dropped here, regardless of who set it.
//
// Built on node:http/node:https (not global fetch): they accept a `lookup` override for IP
// pinning, preserve the Host header and TLS SNI from the original hostname by default, and —
// unlike fetch — do not auto-follow redirects, so refusing them is natural. node:http itself
// adds only transport headers (Host, Connection, Content-Length/Transfer-Encoding) — never
// telemetry — and the allowlist below governs everything we hand it on top of those.

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isBlockedAddress, isBlockedPort } from "./ip-ranges.js";

// The private/reserved address classifier and port allowlist live in ip-ranges.ts so the
// app's save-time endpoint validator can share them instead of duplicating them (#220, #314).
// Re-exported here so existing importers of safe-fetch keep working.
export { isBlockedAddress, isBlockedPort } from "./ip-ranges.js";

// Thrown when a request is refused by the egress policy (bad scheme/userinfo, blocked
// address, refused redirect, resolution failure). Distinct from a normal connection error
// so callers can phrase the failure precisely; both still propagate as request failures.
export class BlockedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedRequestError";
  }
}

// Idle (inactivity) socket timeout. Fires when the socket goes quiet for this long; Node resets
// it on every byte. On its own it cannot stop a slow-drip sender (one byte before each window
// keeps resetting it) — that is what the absolute deadline below is for.
const DEFAULT_TIMEOUT_MS = 30_000;

// Absolute wall-clock deadline spanning connect → first byte → full read. Unlike the idle timeout
// it is never reset by activity, so it reclaims a worker held by a slow-drip / Slowloris-style
// sender or a connect that is accepted but never answered. Must comfortably exceed a legitimate
// response time; tenant Connection responses are small JSON.
const DEFAULT_DEADLINE_MS = 60_000;

// Hard cap on buffered response bytes. Without it a malicious endpoint can stream an unbounded
// body and exhaust worker memory. Generous enough for legitimate dataset pulls (which are already
// row-windowed by the adapters) while still bounding the blast radius.
const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

// https is required in production so the credential is encrypted in flight; http is allowed
// only in development/tests. Mirrors isAllowedEndpointUrl in src/lib/connections/endpoint.ts.
function httpsRequired(): boolean {
  return process.env.NODE_ENV !== "development";
}

export function assertSafeUrl(
  raw: string | URL,
  opts: { checkPort?: (urlPort: string, protocol: string) => boolean } = {}
): URL {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    throw new BlockedRequestError(`Invalid URL: ${String(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BlockedRequestError(`Refusing non-http(s) URL scheme: ${url.protocol}`);
  }
  if (url.protocol === "http:" && httpsRequired()) {
    throw new BlockedRequestError("Endpoint must use HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new BlockedRequestError("Refusing URL with embedded credentials (userinfo)");
  }
  const portChecker = opts.checkPort ?? isBlockedPort;
  if (portChecker(url.port, url.protocol)) {
    throw new BlockedRequestError(
      `Refusing URL with non-allowlisted port: ${url.port} (allowed: 443 for https, 80 for http)`
    );
  }
  return url;
}

// ---------------------------------------------------------------------------
// safeFetch
// ---------------------------------------------------------------------------

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  // Outbound header allowlist (#222). When set, only headers whose name (case-insensitive)
  // appears here are sent; every other header — whether passed in `headers` or injected by some
  // global instrumentation — is dropped. `Content-Length` is always allowed because it is a
  // transport header safeFetch computes itself from `body`. Tenant-bound call sites MUST pass
  // this — they do so via tenantRequestHeaders(), which returns the headers and the matching
  // allowlist together so the two can't drift. When omitted, headers pass through unfiltered
  // (used only for non-tenant, fixed-host internal calls).
  allowedHeaders?: readonly string[];
}

// Filter `headers` down to the allowlist (case-insensitive on the header name). The set is
// lowercased once; `Content-Length` is implicitly allowed since safeFetch owns it. Returns a
// fresh object so the caller's input is never mutated.
function applyHeaderAllowlist(
  headers: Record<string, string>,
  allowed: readonly string[]
): Record<string, string> {
  const allow = new Set(allowed.map((h) => h.toLowerCase()));
  allow.add("content-length");
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (allow.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

// Build the headers AND the matching allowlist for a tenant-bound Connection request (#222).
// The allowlist is derived from exactly the headers we intentionally set, so the two can never
// drift: a header that isn't deliberately added here is, by construction, not on the list and is
// dropped by safeFetch. This is the one blessed way to assemble tenant-bound request headers —
// every tenant fetch site (agent invoker, custom + posthog dataset adapters) routes through it,
// so a new call site inherits the leak-proofing instead of re-deriving (and possibly forgetting)
// its own allowlist. Pass `json: true` when a JSON body is sent; supply the Connection's
// configured auth header/value to carry its credential (omitted cleanly when either is absent).
export function tenantRequestHeaders(opts: {
  authHeader?: string | null;
  authValue?: string | null;
  json?: boolean;
}): { headers: Record<string, string>; allowedHeaders: string[] } {
  const headers: Record<string, string> = {};
  if (opts.json) headers["Content-Type"] = "application/json";
  // The stored secret IS the full header value (e.g. "Bearer sk-..."), used verbatim.
  if (opts.authHeader && opts.authValue) headers[opts.authHeader] = opts.authValue;
  return { headers, allowedHeaders: Object.keys(headers) };
}

// A minimal fetch-Response shape: the Connection fetch sites only read ok/status/json().
export interface SafeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

interface ResolvedAddress {
  address: string;
  family: number;
}

// Seams for tests: override DNS resolution and/or the address/port policy so the transport
// behaviour can be exercised over loopback without depending on real DNS.
export interface SafeFetchDeps {
  lookupAll?: (hostname: string) => Promise<ResolvedAddress[]>;
  isBlocked?: (ip: string) => boolean;
  // Port policy override: replaces the isBlockedPort check in assertSafeUrl. Transport tests
  // set this to () => false so they can bind to an OS-assigned port without triggering the
  // allowlist; security-policy tests omit it and rely on the real isBlockedPort.
  isPortBlocked?: (urlPort: string, protocol: string) => boolean;
  // Idle socket timeout (ms). Resets on activity — a secondary guard.
  timeoutMs?: number;
  // Absolute wall-clock deadline (ms) for the whole exchange. Never reset by activity.
  deadlineMs?: number;
  // Maximum buffered response body (bytes) before the request is refused.
  maxBodyBytes?: number;
}

const defaultLookupAll = (hostname: string): Promise<ResolvedAddress[]> =>
  dnsLookup(hostname, { all: true, verbatim: true });

export async function safeFetch(
  rawUrl: string | URL,
  init: SafeFetchInit = {},
  deps: SafeFetchDeps = {}
): Promise<SafeResponse> {
  const url = assertSafeUrl(rawUrl, { checkPort: deps.isPortBlocked });
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, ""); // strip IPv6 brackets
  const lookupAll = deps.lookupAll ?? defaultLookupAll;
  const isBlocked = deps.isBlocked ?? isBlockedAddress;

  let resolved: ResolvedAddress[];
  try {
    resolved = await lookupAll(host);
  } catch (err) {
    throw new BlockedRequestError(`DNS resolution failed for ${host}: ${errMessage(err)}`);
  }
  if (resolved.length === 0) {
    throw new BlockedRequestError(`No addresses resolved for ${host}`);
  }
  for (const { address } of resolved) {
    if (isBlocked(address)) {
      throw new BlockedRequestError(
        `Refusing to connect to ${host}: resolves to blocked address ${address}`
      );
    }
  }

  return performRequest(url, host, init, resolved, {
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    deadlineMs: deps.deadlineMs ?? DEFAULT_DEADLINE_MS,
    maxBodyBytes: deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  });
}

interface RequestLimits {
  timeoutMs: number;
  deadlineMs: number;
  maxBodyBytes: number;
}

function performRequest(
  url: URL,
  host: string,
  init: SafeFetchInit,
  pinned: ResolvedAddress[],
  limits: RequestLimits
): Promise<SafeResponse> {
  const { timeoutMs, deadlineMs, maxBodyBytes } = limits;
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;

    // Settle exactly once and always clear the deadline timer when we do, so a late timer can't
    // fire after success and so the timer never keeps the event loop alive past completion.
    let settled = false;
    // Held in a const container so the settle closures (defined here, before the timer is armed
    // below) can clear it without a forward `let` reassignment.
    const timers: { deadline?: ReturnType<typeof setTimeout> } = {};
    const succeed = (value: SafeResponse): void => {
      if (settled) return;
      settled = true;
      if (timers.deadline) clearTimeout(timers.deadline);
      resolve(value);
    };
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      if (timers.deadline) clearTimeout(timers.deadline);
      reject(err);
    };

    // Build the outbound header set, then — if the call site provided an allowlist (every
    // tenant-bound site does, #222) — drop anything not on it. Applied here, at the single
    // chokepoint that all three Connection fetch sites funnel through, so no adapter can leak
    // an internal header and no header injected upstream survives to the wire.
    const headers: Record<string, string> =
      init.allowedHeaders === undefined
        ? { ...(init.headers ?? {}) }
        : applyHeaderAllowlist(init.headers ?? {}, init.allowedHeaders);
    const body = init.body;
    if (
      body !== undefined &&
      headers["Content-Length"] === undefined &&
      headers["content-length"] === undefined
    ) {
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }

    // Pin the socket to an address we already validated. By ignoring the hostname here we
    // guarantee no second DNS lookup happens between validation and connect, closing the
    // DNS-rebinding window.
    const pinnedLookup = (
      _hostname: string,
      options: { all?: boolean },
      cb: (
        err: NodeJS.ErrnoException | null,
        address: string | ResolvedAddress[],
        family?: number
      ) => void
    ): void => {
      if (options && options.all) {
        cb(null, pinned.map((a) => ({ address: a.address, family: a.family })));
      } else {
        cb(null, pinned[0].address, pinned[0].family);
      }
    };

    const req = requestFn(
      {
        protocol: url.protocol,
        hostname: host, // preserves the Host header and (via servername) TLS SNI
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers,
        lookup: pinnedLookup,
        ...(isHttps ? { servername: host } : {}),
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        // Refuse redirects: the Location could point at an internal address and we must not
        // dereference it. Not following it means no fetch to the redirect target happens.
        if (status >= 300 && status < 400 && res.headers.location !== undefined) {
          res.destroy();
          fail(
            new BlockedRequestError(
              `Refusing to follow redirect from ${host} to ${res.headers.location}`
            )
          );
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk) => {
          received += (chunk as Buffer).length;
          // Cap the buffered body: an endpoint that streams without end would otherwise exhaust
          // worker memory. Tear the socket down as soon as the cap is crossed so we stop reading.
          if (received > maxBodyBytes) {
            req.destroy();
            res.destroy();
            fail(
              new BlockedRequestError(
                `Refusing response from ${host}: body exceeded ${maxBodyBytes} bytes`
              )
            );
            return;
          }
          chunks.push(chunk as Buffer);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          succeed({
            ok: status >= 200 && status < 300,
            status,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
        res.on("error", fail);
      }
    );

    req.on("error", fail);
    // Idle timeout: socket goes quiet for timeoutMs. Resets on activity (secondary guard).
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request to ${host} timed out after ${timeoutMs}ms`));
    });
    // Absolute deadline: fires regardless of activity, defeating slow-drip / silent-connect
    // holds that the idle timeout alone never catches. Destroying the request surfaces via the
    // 'error' handler, but we settle here directly so the message is precise.
    timers.deadline = setTimeout(() => {
      req.destroy();
      fail(new BlockedRequestError(`Request to ${host} exceeded deadline of ${deadlineMs}ms`));
    }, deadlineMs);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
