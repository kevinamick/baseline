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
//
// Built on node:http/node:https (not global fetch): they accept a `lookup` override for IP
// pinning, preserve the Host header and TLS SNI from the original hostname by default, and —
// unlike fetch — do not auto-follow redirects, so refusing them is natural.

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isBlockedAddress } from "./ip-ranges.js";

// The private/reserved address classifier lives in ip-ranges.ts so the app's save-time
// endpoint validator can share the exact same ranges instead of duplicating them (#220).
// Re-exported here so existing importers of safe-fetch keep working.
export { isBlockedAddress } from "./ip-ranges.js";

// Thrown when a request is refused by the egress policy (bad scheme/userinfo, blocked
// address, refused redirect, resolution failure). Distinct from a normal connection error
// so callers can phrase the failure precisely; both still propagate as request failures.
export class BlockedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedRequestError";
  }
}

// Default socket timeout. The original fetch sites had none; an internal host that accepts a
// connection but never responds would otherwise hang a rollout indefinitely.
const DEFAULT_TIMEOUT_MS = 30_000;

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

// https is required in production so the credential is encrypted in flight; http is allowed
// only in development/tests. Mirrors isAllowedEndpointUrl in src/lib/connections/endpoint.ts.
function httpsRequired(): boolean {
  return process.env.NODE_ENV !== "development";
}

export function assertSafeUrl(raw: string | URL): URL {
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
  return url;
}

// ---------------------------------------------------------------------------
// safeFetch
// ---------------------------------------------------------------------------

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
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

// Seams for tests: override DNS resolution and/or the address policy so the transport
// behaviour can be exercised over loopback without depending on real DNS.
export interface SafeFetchDeps {
  lookupAll?: (hostname: string) => Promise<ResolvedAddress[]>;
  isBlocked?: (ip: string) => boolean;
  timeoutMs?: number;
}

const defaultLookupAll = (hostname: string): Promise<ResolvedAddress[]> =>
  dnsLookup(hostname, { all: true, verbatim: true });

export async function safeFetch(
  rawUrl: string | URL,
  init: SafeFetchInit = {},
  deps: SafeFetchDeps = {}
): Promise<SafeResponse> {
  const url = assertSafeUrl(rawUrl);
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

  return performRequest(url, host, init, resolved, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

function performRequest(
  url: URL,
  host: string,
  init: SafeFetchInit,
  pinned: ResolvedAddress[],
  timeoutMs: number
): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;

    const headers: Record<string, string> = { ...(init.headers ?? {}) };
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
          reject(
            new BlockedRequestError(
              `Refusing to follow redirect from ${host} to ${res.headers.location}`
            )
          );
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
        res.on("error", reject);
      }
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request to ${host} timed out after ${timeoutMs}ms`));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}
