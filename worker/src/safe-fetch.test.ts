import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import { lookup as dnsPromisesLookup } from "node:dns/promises";
import {
  safeFetch,
  assertSafeUrl,
  tenantRequestHeaders,
  BlockedRequestError,
} from "./safe-fetch.js";

// Wrap node:dns/promises' lookup in a pass-through spy so ONE test (the default-lookup-options
// test below) can intercept the module-level dnsLookup that safeFetch's defaultLookupAll uses
// when no deps.lookupAll is injected. Every other test sees the real implementation.
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

// The address classifier (isBlockedAddress / isBlockedIpLiteral) now lives in ip-ranges.ts
// and is covered by ip-ranges.test.ts. This file covers the URL policy + transport.

describe("tenantRequestHeaders (#222)", () => {
  it("derives the allowlist from exactly the headers it sets", () => {
    const { headers, allowedHeaders } = tenantRequestHeaders({
      authHeader: "Authorization",
      authValue: "Bearer s3cr3t",
      json: true,
    });
    expect(headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer s3cr3t",
    });
    // The allowlist is the key set of the headers — it can never name a header that isn't sent,
    // nor omit one that is, so headers and allowlist can't drift.
    expect(allowedHeaders).toEqual(Object.keys(headers));
    expect(allowedHeaders).toEqual(["Content-Type", "Authorization"]);
  });

  it("omits Content-Type for a body-less (GET) call", () => {
    const { headers, allowedHeaders } = tenantRequestHeaders({
      authHeader: "X-Api-Key",
      authValue: "k3y",
    });
    expect(headers).toEqual({ "X-Api-Key": "k3y" });
    expect(allowedHeaders).toEqual(["X-Api-Key"]);
  });

  it("does not name the auth header when there is no value to carry", () => {
    // Tighter than naming the header regardless of value: a header with no value is never sent,
    // so it must not appear on the allowlist either.
    const { headers, allowedHeaders } = tenantRequestHeaders({
      authHeader: "Authorization",
      authValue: null,
      json: true,
    });
    expect(headers).toEqual({ "Content-Type": "application/json" });
    expect(allowedHeaders).toEqual(["Content-Type"]);
  });

  it("yields an empty set for a body-less, auth-less call", () => {
    expect(tenantRequestHeaders({})).toEqual({
      headers: {},
      allowedHeaders: [],
    });
  });
});

describe("assertSafeUrl", () => {
  it("accepts an https URL", () => {
    expect(assertSafeUrl("https://api.example.com/x").hostname).toBe(
      "api.example.com",
    );
  });

  it("accepts https with explicit port 443", () => {
    // WHATWG URL normalizes :443 on https to "" (default port stripped). Verify no error thrown.
    expect(() => assertSafeUrl("https://api.example.com:443/x")).not.toThrow();
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow(
      BlockedRequestError,
    );
    expect(() => assertSafeUrl("ftp://host/x")).toThrow(/non-http/);
    expect(() => assertSafeUrl("gopher://host")).toThrow(BlockedRequestError);
  });

  it("rejects userinfo (credentials embedded in the URL)", () => {
    expect(() => assertSafeUrl("https://user:pass@host/x")).toThrow(/userinfo/);
    expect(() => assertSafeUrl("https://user@host/x")).toThrow(/userinfo/);
  });

  it("rejects http outside development (https-only rule preserved)", () => {
    // vitest sets NODE_ENV=test, which is not "development", so http is refused.
    expect(() => assertSafeUrl("http://host/x")).toThrow(/HTTPS/);
  });

  it("allows http in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(assertSafeUrl("http://host/x").protocol).toBe("http:");
    vi.unstubAllEnvs();
  });

  it("rejects a malformed URL", () => {
    expect(() => assertSafeUrl("not a url")).toThrow(BlockedRequestError);
  });

  it("rejects a non-allowlisted explicit port on https", () => {
    expect(() => assertSafeUrl("https://api.example.com:6379/")).toThrow(
      /non-allowlisted port/,
    );
    expect(() => assertSafeUrl("https://api.example.com:8443/")).toThrow(
      BlockedRequestError,
    );
    expect(() => assertSafeUrl("https://api.example.com:8080/")).toThrow(
      BlockedRequestError,
    );
  });

  it("rejects a non-allowlisted explicit port on http in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => assertSafeUrl("http://host:8080/")).toThrow(
      /non-allowlisted port/,
    );
    vi.unstubAllEnvs();
  });

  it("accepts http with explicit port 80 in development", () => {
    // WHATWG URL normalizes :80 on http to "" (default port stripped). Verify no error thrown.
    vi.stubEnv("NODE_ENV", "development");
    expect(() => assertSafeUrl("http://host:80/")).not.toThrow();
    vi.unstubAllEnvs();
  });

  it("allows a custom port check to be injected (transport test bypass)", () => {
    // Transport tests need to bind to OS-assigned ports; they inject isPortBlocked: () => false.
    expect(
      assertSafeUrl("https://host:9999/", { isPortBlocked: () => false }).port,
    ).toBe("9999");
  });
});

describe("safeFetch egress policy (no connection made)", () => {
  // Literal IPs resolve offline, so these never touch the network. https keeps the scheme
  // check happy under NODE_ENV=test.
  it("blocks the cloud metadata IP", async () => {
    await expect(
      safeFetch("https://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/blocked address 169\.254\.169\.254/);
  });

  it("blocks loopback", async () => {
    await expect(safeFetch("https://127.0.0.1/")).rejects.toBeInstanceOf(
      BlockedRequestError,
    );
  });

  it("blocks an IPv4-mapped IPv6 metadata address", async () => {
    await expect(
      safeFetch("https://[::ffff:169.254.169.254]/"),
    ).rejects.toThrow(BlockedRequestError);
  });

  it("blocks an RFC1918 literal", async () => {
    await expect(safeFetch("https://10.0.0.5/")).rejects.toThrow(
      BlockedRequestError,
    );
  });

  it("blocks when a public hostname resolves to a private address (DNS rebinding)", async () => {
    // The attack: a public-looking hostname whose A record points inside the perimeter.
    // safeFetch validates the resolved address and refuses before connecting.
    const lookupAll = async () => [{ address: "10.1.2.3", family: 4 }];
    await expect(
      safeFetch("https://rebind.evil.test/", {}, { lookupAll }),
    ).rejects.toThrow(/blocked address 10\.1\.2\.3/);
  });

  it("refuses to connect when DNS returns no addresses", async () => {
    await expect(
      safeFetch("https://void.test/", {}, { lookupAll: async () => [] }),
    ).rejects.toThrow(/No addresses/);
  });

  it("wraps a DNS resolution failure as a BlockedRequestError", async () => {
    const lookupAll = async () => {
      throw new Error("ENOTFOUND nowhere.test");
    };
    await expect(
      safeFetch("https://nowhere.test/", {}, { lookupAll }),
    ).rejects.toThrow(/DNS resolution failed for nowhere\.test: ENOTFOUND nowhere\.test/);
    await expect(safeFetch("https://nowhere.test/", {}, { lookupAll })).rejects.toBeInstanceOf(
      BlockedRequestError,
    );
  });

  it("wraps a non-Error DNS rejection using its string form", async () => {
    const lookupAll = async () => {
      // Intentionally throws a bare string to exercise the non-Error branch of errMessage.
      throw "raw string rejection";
    };
    await expect(
      safeFetch("https://nowhere2.test/", {}, { lookupAll }),
    ).rejects.toThrow(/DNS resolution failed for nowhere2\.test: raw string rejection/);
  });
});

describe("safeFetch transport (loopback server)", () => {
  let server: Server;
  let received: IncomingMessage[] = [];
  let port = 0;

  // Permit loopback and any OS-assigned port so the real transport can be exercised.
  // Security policy (IP blocking, port allowlist) is covered separately above.
  const allowLoopback = { isBlocked: () => false, isPortBlocked: () => false };

  function start(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<void> {
    received = [];
    server = createServer((req, res) => {
      received.push(req);
      handler(req, res);
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns ok + parsed json on a 2xx response", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hello: "world" }));
    });

    const res = await safeFetch(
      `http://127.0.0.1:${port}/data`,
      {},
      allowLoopback,
    );
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world" });
  });

  it("exposes the raw response body via .text() as well as .json()", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => {
      res.writeHead(200);
      res.end("plain text body");
    });

    const res = await safeFetch(`http://127.0.0.1:${port}/data`, {}, allowLoopback);
    expect(await res.text()).toBe("plain text body");
  });

  it("reports a non-2xx as ok=false without throwing", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => {
      res.writeHead(502);
      res.end("bad gateway");
    });

    const res = await safeFetch(`http://127.0.0.1:${port}/`, {}, allowLoopback);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
  });

  it("sends method, headers and body through to the server", async () => {
    vi.stubEnv("NODE_ENV", "development");
    let body = "";
    await start((req, res) => {
      req.on("data", (c) => (body += c));
      req.on("end", () => res.end("ok"));
    });

    await safeFetch(
      `http://127.0.0.1:${port}/q`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer s3cr3t",
        },
        body: JSON.stringify({ query: 1 }),
      },
      allowLoopback,
    );

    const req = received[0];
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe("Bearer s3cr3t");
    expect(body).toBe(JSON.stringify({ query: 1 }));
  });

  it("allowedHeaders strips internal headers and keeps only the allowlist (#222)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => res.end("ok"));

    // The caller's header map carries both the legitimate auth header AND a pile of internal /
    // propagation headers that some upstream layer might inject. With an allowlist naming only
    // Content-Type + the auth header, none of the internal ones reach the wire.
    await safeFetch(
      `http://127.0.0.1:${port}/q`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer s3cr3t",
          traceparent:
            "00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01",
          tracestate: "vendor=value",
          baggage: "org_id=team-123",
          "x-org-id": "team-123",
          "x-posthog-key": "phc_internal",
        },
        body: JSON.stringify({ q: 1 }),
        allowedHeaders: ["Content-Type", "Authorization"],
      },
      allowLoopback,
    );

    const req = received[0];
    expect(req.headers.authorization).toBe("Bearer s3cr3t");
    expect(req.headers["content-type"]).toBe("application/json");
    // Everything off the allowlist is gone — no trace propagation, no org id, no telemetry key.
    expect(req.headers.traceparent).toBeUndefined();
    expect(req.headers.tracestate).toBeUndefined();
    expect(req.headers.baggage).toBeUndefined();
    expect(req.headers["x-org-id"]).toBeUndefined();
    expect(req.headers["x-posthog-key"]).toBeUndefined();
  });

  it("allowedHeaders matches header names case-insensitively (#222)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => res.end("ok"));

    // The auth header is configured as "X-Api-Key" but the allowlist names "x-api-key": a case
    // mismatch must still let the legitimate header through (HTTP header names are case-
    // insensitive), while an unrelated header is still dropped.
    await safeFetch(
      `http://127.0.0.1:${port}/q`,
      {
        method: "GET",
        headers: { "X-Api-Key": "k3y", "X-Trace-Id": "leak" },
        allowedHeaders: ["x-api-key"],
      },
      allowLoopback,
    );

    const req = received[0];
    expect(req.headers["x-api-key"]).toBe("k3y");
    expect(req.headers["x-trace-id"]).toBeUndefined();
  });

  it("applies the allowlist against an empty header set when no headers are passed at all", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => res.end("ok"));

    // allowedHeaders is set but init.headers itself is omitted — applyHeaderAllowlist must
    // still run against an empty object rather than throwing.
    await safeFetch(
      `http://127.0.0.1:${port}/q`,
      { method: "GET", allowedHeaders: ["Authorization"] },
      allowLoopback,
    );

    expect(received[0].headers.authorization).toBeUndefined();
  });

  it("without allowedHeaders, headers pass through unfiltered (internal fixed-host calls)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => res.end("ok"));

    // Back-compat: when no allowlist is supplied (non-tenant internal callers), headers are
    // sent as-is. Tenant-bound sites always pass an allowlist; this branch is for fixed hosts.
    await safeFetch(
      `http://127.0.0.1:${port}/q`,
      { method: "GET", headers: { "X-Internal": "ok" } },
      allowLoopback,
    );

    expect(received[0].headers["x-internal"]).toBe("ok");
  });

  it("refuses a 3xx redirect and never fetches the redirect target", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => {
      res.writeHead(302, {
        Location: "http://169.254.169.254/latest/meta-data/",
      });
      res.end();
    });

    await expect(
      safeFetch(`http://127.0.0.1:${port}/redirect`, {}, allowLoopback),
    ).rejects.toThrow(/Refusing to follow redirect/);
    // Only the original request reached our server; the redirect target was never fetched.
    expect(received).toHaveLength(1);
  });

  it("pins to the validated IP when Node's connection lookup requests a single address (no Happy Eyeballs)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => res.end("ok"));

    // Node 19+ defaults to Happy Eyeballs (autoSelectFamily), which calls the custom `lookup`
    // with { all: true }. Disabling it makes Node request a single address instead, exercising
    // safeFetch's other pinnedLookup branch (cb(null, address, family) rather than an array).
    const net = await import("node:net");
    const original = net.getDefaultAutoSelectFamily();
    net.setDefaultAutoSelectFamily(false);
    try {
      const res = await safeFetch(
        `http://pinned-single.example.test:${port}/`,
        {},
        {
          isBlocked: () => false,
          isPortBlocked: () => false,
          lookupAll: async () => [{ address: "127.0.0.1", family: 4 }],
        },
      );
      expect(res.ok).toBe(true);
      expect(received).toHaveLength(1);
    } finally {
      net.setDefaultAutoSelectFamily(original);
    }
  });

  it("pins to the validated IP while preserving the original Host header (rebinding-proof)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => res.end("ok"));

    // The URL hostname is a name, but we hand safeFetch the validated loopback IP. The socket
    // connects to that pinned IP (no re-resolution), yet the Host header carries the hostname.
    await safeFetch(
      `http://pinned.example.test:${port}/`,
      {},
      {
        isBlocked: () => false,
        isPortBlocked: () => false,
        lookupAll: async () => [{ address: "127.0.0.1", family: 4 }],
      },
    );

    expect(received).toHaveLength(1);
    expect(received[0].headers.host).toBe(`pinned.example.test:${port}`);
  });
});

describe("safeFetch DoS hardening (loopback)", () => {
  // A separate harness from the transport block above because these servers drip forever and
  // must be torn down by their own interval cleanup, not by ending the response.
  let server: Server;
  let port = 0;

  function startServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<void> {
    server = createServer(handler);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("kills a slow-drip response via the absolute deadline (idle timeout never fires)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    // The classic slow sinkhole: accept the request, then dribble one byte well inside any idle
    // window, forever. An inactivity timeout keeps getting reset and never fires — only a
    // wall-clock deadline spanning the whole exchange can reclaim the worker.
    await startServer((_req, res) => {
      res.writeHead(200);
      const drip = setInterval(() => res.write("."), 10);
      res.on("close", () => clearInterval(drip));
    });

    await expect(
      safeFetch(
        `http://127.0.0.1:${port}/drip`,
        {},
        // Idle timeout is generous so it can't be what stops this; the deadline must.
        {
          isBlocked: () => false,
          isPortBlocked: () => false,
          timeoutMs: 5_000,
          deadlineMs: 150,
        },
      ),
    ).rejects.toThrow(/deadline/);
  }, 2_000);

  it("kills a hung connection via the idle timeout when it fires before the deadline", async () => {
    vi.stubEnv("NODE_ENV", "development");
    // Accept the socket but never respond. A generous deadline can't be what stops this — only
    // the shorter idle (inactivity) timeout, which fires because the socket never sees a byte.
    await startServer(() => {
      /* hold the socket open and silent: never write a status line */
    });

    await expect(
      safeFetch(
        `http://127.0.0.1:${port}/silent`,
        {},
        {
          isBlocked: () => false,
          isPortBlocked: () => false,
          timeoutMs: 150,
          deadlineMs: 5_000,
        },
      ),
    ).rejects.toThrow(/timed out after 150ms/);
  }, 2_000);

  it("kills a stalled connect via the absolute deadline (accepts then sends nothing)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    // Accept the socket but never write a status line: no response bytes ever arrive. The same
    // wall-clock deadline bounds connect→first-byte, not just the read phase.
    await startServer(() => {
      /* hold the socket open and silent: never write a status line */
    });

    await expect(
      safeFetch(
        `http://127.0.0.1:${port}/silent`,
        {},
        {
          isBlocked: () => false,
          isPortBlocked: () => false,
          timeoutMs: 5_000,
          deadlineMs: 150,
        },
      ),
    ).rejects.toThrow(/deadline/);
  }, 2_000);

  it("refuses a response body once it exceeds the size cap, and stops reading", async () => {
    vi.stubEnv("NODE_ENV", "development");
    let written = 0;
    await startServer((_req, res) => {
      res.writeHead(200);
      const pump = setInterval(() => {
        res.write("x".repeat(1024));
        written += 1024;
      }, 5);
      res.on("close", () => clearInterval(pump));
    });

    await expect(
      safeFetch(
        `http://127.0.0.1:${port}/firehose`,
        {},
        {
          isBlocked: () => false,
          isPortBlocked: () => false,
          maxBodyBytes: 4096,
        },
      ),
    ).rejects.toBeInstanceOf(BlockedRequestError);
    // It bailed promptly rather than buffering an unbounded body — the server didn't get to pump
    // megabytes before the socket was torn down. (Loose bound; just proves it didn't drain it all.)
    expect(written).toBeLessThan(1024 * 1024);
  }, 2_000);

  it("honors an external abort signal, tearing down a hung request (#102 probe)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    // Accept the socket but never respond — the outage mode the #102 health probe gives a short
    // leash so it yields an endpoint-down verdict before its Activity timeout fires. The caller's
    // signal must reclaim the socket independently of safeFetch's own (generous here) deadline.
    await startServer(() => {
      /* hold the socket open and silent */
    });

    await expect(
      safeFetch(
        `http://127.0.0.1:${port}/silent`,
        { signal: AbortSignal.timeout(100) },
        {
          isBlocked: () => false,
          isPortBlocked: () => false,
          timeoutMs: 5_000,
          deadlineMs: 5_000,
        },
      ),
    ).rejects.toThrow(/aborted/);
  }, 2_000);

  it("rejects immediately when handed an already-aborted signal", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await startServer((_req, res) => res.end("ok"));

    await expect(
      safeFetch(
        `http://127.0.0.1:${port}/`,
        { signal: AbortSignal.abort() },
        { isBlocked: () => false, isPortBlocked: () => false },
      ),
    ).rejects.toThrow(/aborted/);
  }, 2_000);
});

describe("assertSafeUrl policy details", () => {
  it("names the offending input in the invalid-URL rejection", () => {
    expect(() => assertSafeUrl("not a url")).toThrow("Invalid URL: not a url");
  });

  it("tags policy errors with the BlockedRequestError name", () => {
    let caught: unknown;
    try {
      assertSafeUrl("ftp://host/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BlockedRequestError);
    expect((caught as Error).name).toBe("BlockedRequestError");
  });

  it("returns the very same URL instance it was given (no re-parse of a URL object)", () => {
    const url = new URL("https://api.example.com/x?q=1");
    expect(assertSafeUrl(url)).toBe(url);
  });

  it("states the userinfo refusal precisely, and safeFetch refuses before any resolution", async () => {
    expect(() => assertSafeUrl("https://user:pass@host/x")).toThrow(
      "Refusing URL with embedded credentials (userinfo)",
    );
    // End-to-end through safeFetch: refused at URL policy, before DNS or any socket.
    await expect(
      safeFetch("https://user:pass@internal.test/"),
    ).rejects.toThrow(/embedded credentials \(userinfo\)/);
    await expect(safeFetch("https://user@internal.test/")).rejects.toBeInstanceOf(
      BlockedRequestError,
    );
  });
});

describe("safeFetch default DNS lookup (no injected resolver)", () => {
  it("resolves via dns.lookup with { all: true, verbatim: true }", async () => {
    const seenOptions: unknown[] = [];
    (
      dnsPromisesLookup as unknown as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(async (_hostname: string, options: unknown) => {
      seenOptions.push(options);
      // A private address, so safeFetch refuses before any socket is opened.
      return [{ address: "10.9.9.9", family: 4 }];
    });

    await expect(safeFetch("https://dns-defaults.example.test/")).rejects.toThrow(
      /blocked address 10\.9\.9\.9/,
    );
    // all:true — every resolved address must be validated, not just the first; verbatim:true —
    // addresses are checked in resolver order, no A/AAAA reordering between validate and connect.
    expect(seenOptions).toEqual([{ all: true, verbatim: true }]);
  });
});

describe("safeFetch IPv6 host normalization", () => {
  it("strips the brackets from an IPv6 literal before resolution and in error copy", async () => {
    const seenHosts: string[] = [];
    const lookupAll = async (h: string) => {
      seenHosts.push(h);
      return [{ address: "10.1.1.1", family: 4 }];
    };
    await expect(
      safeFetch("https://[2001:db8::7]/", {}, { lookupAll }),
    ).rejects.toThrow(
      "Refusing to connect to 2001:db8::7: resolves to blocked address 10.1.1.1",
    );
    // The resolver was handed the bare address — no brackets, no sentinel text.
    expect(seenHosts).toEqual(["2001:db8::7"]);
  });
});

describe("safeFetch transport details (loopback)", () => {
  let server: Server;
  let port = 0;

  const allowLoopback = { isBlocked: () => false, isPortBlocked: () => false };

  function start(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<void> {
    server = createServer(handler);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  // Echo the request line + headers back as JSON without reading the body, so tests can assert
  // exactly what reached the wire (including a Content-Length the server never waits on).
  const echoHandler = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ method: req.method, url: req.url, headers: req.headers }),
    );
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("uses TLS for https URLs (a plain-http listener refuses the handshake)", async () => {
    await start((_req, res) => res.end("plaintext ok"));
    // A real TLS ClientHello against a plaintext server fails with a TLS-level EPROTO error.
    // A broken scheme check would either succeed (plain http reaches the listener) or fail
    // with node:http's ERR_INVALID_PROTOCOL — neither of which is an EPROTO handshake failure.
    await expect(
      safeFetch(
        `https://127.0.0.1:${port}/`,
        {},
        { ...allowLoopback, deadlineMs: 3_000 },
      ),
    ).rejects.toThrow(/EPROTO|wrong version/i);
  }, 5_000);

  it("sends the exact path+query and a byte-accurate auto Content-Length for a body", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start(echoHandler);

    const body = "héllo"; // 5 chars but 6 UTF-8 bytes: Content-Length must be byte length
    const res = await safeFetch(
      `http://127.0.0.1:${port}/data?x=1&y=2`,
      { method: "POST", body },
      allowLoopback,
    );
    const echoed = (await res.json()) as {
      url: string;
      headers: Record<string, string>;
    };
    expect(echoed.url).toBe("/data?x=1&y=2");
    expect(echoed.headers["content-length"]).toBe("6");
  });

  it("honors a caller-supplied Content-Length instead of recomputing it", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start(echoHandler);

    // The caller's value (999) deliberately differs from the body's byte length (5): if the
    // auto-compute guard were broken, the recomputed "5" would reach the wire instead.
    const res = await safeFetch(
      `http://127.0.0.1:${port}/cl`,
      { method: "POST", body: "hello", headers: { "Content-Length": "999" } },
      { ...allowLoopback, deadlineMs: 3_000 },
    );
    const echoed = (await res.json()) as { headers: Record<string, string> };
    expect(echoed.headers["content-length"]).toBe("999");
  }, 5_000);

  it("honors a caller-supplied lowercase content-length too", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start(echoHandler);

    const res = await safeFetch(
      `http://127.0.0.1:${port}/cl-lower`,
      { method: "POST", body: "hello", headers: { "content-length": "777" } },
      { ...allowLoopback, deadlineMs: 3_000 },
    );
    const echoed = (await res.json()) as { headers: Record<string, string> };
    expect(echoed.headers["content-length"]).toBe("777");
  }, 5_000);

  it("always lets Content-Length through a header allowlist (transport header ownership)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start(echoHandler);

    // No body, so nothing is recomputed: the caller's Content-Length survives ONLY because the
    // allowlist implicitly admits content-length. The unlisted header is still dropped.
    const res = await safeFetch(
      `http://127.0.0.1:${port}/g`,
      {
        method: "GET",
        headers: { "Content-Length": "0", "X-Drop": "leak" },
        allowedHeaders: [],
      },
      allowLoopback,
    );
    const echoed = (await res.json()) as { headers: Record<string, string> };
    expect(echoed.headers["content-length"]).toBe("0");
    expect(echoed.headers["x-drop"]).toBeUndefined();
  });

  it("treats a 2xx with a stray Location header as a normal response", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => {
      res.writeHead(200, { Location: "/elsewhere" });
      res.end("fine");
    });

    const res = await safeFetch(`http://127.0.0.1:${port}/`, {}, allowLoopback);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("fine");
  });

  it("refuses a redirect at the 300 boundary exactly", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => {
      res.writeHead(300, { Location: "/other" });
      res.end();
    });

    await expect(
      safeFetch(`http://127.0.0.1:${port}/`, {}, allowLoopback),
    ).rejects.toThrow(/Refusing to follow redirect from 127\.0\.0\.1 to \/other/);
  });

  it("returns a 3xx WITHOUT a Location header as a plain non-ok response", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => {
      res.writeHead(300);
      res.end("choices");
    });

    const res = await safeFetch(`http://127.0.0.1:${port}/`, {}, allowLoopback);
    // Nothing to follow, so it is not refused; and 300 is not a 2xx, so ok is false.
    expect(res.status).toBe(300);
    expect(res.ok).toBe(false);
    expect(await res.text()).toBe("choices");
  });

  it("treats a 4xx with a Location header as a normal response (not a redirect)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => {
      res.writeHead(400, { Location: "/nope" });
      res.end("bad request");
    });

    const res = await safeFetch(`http://127.0.0.1:${port}/`, {}, allowLoopback);
    expect(res.status).toBe(400);
    expect(res.ok).toBe(false);
  });

  it("accepts a body of exactly maxBodyBytes (cap is exclusive)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => {
      res.writeHead(200);
      res.end("x".repeat(8));
    });

    const res = await safeFetch(
      `http://127.0.0.1:${port}/`,
      {},
      { ...allowLoopback, maxBodyBytes: 8 },
    );
    expect(await res.text()).toBe("x".repeat(8));
  });

  it("names the byte cap when refusing an oversized body", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => {
      res.writeHead(200);
      res.end("x".repeat(9));
    });

    await expect(
      safeFetch(
        `http://127.0.0.1:${port}/`,
        {},
        { ...allowLoopback, maxBodyBytes: 8 },
      ),
    ).rejects.toThrow(/body exceeded 8 bytes/);
  });

  it("uses a megabyte-scale default body cap (a KB-scale body passes untouched)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => {
      res.writeHead(200);
      res.end("x".repeat(5_000));
    });

    // No maxBodyBytes injected: the 25 MiB default applies. A 5 KB body must sail through —
    // a mis-multiplied default (25 or 0.02 bytes) would refuse it.
    const res = await safeFetch(`http://127.0.0.1:${port}/`, {}, allowLoopback);
    expect((await res.text()).length).toBe(5_000);
  });

  it("clears the absolute deadline timer once the response settles", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      await start((_req, res) => res.end("ok"));

      const res = await safeFetch(
        `http://127.0.0.1:${port}/`,
        {},
        { ...allowLoopback, deadlineMs: 54_321 },
      );
      expect(res.ok).toBe(true);

      // Find the deadline timer by its sentinel delay, then require that exact handle to have
      // been cleared — otherwise the timer would outlive the request and hold the event loop.
      const armedIdx = setSpy.mock.calls.findIndex((c) => c[1] === 54_321);
      expect(armedIdx).toBeGreaterThanOrEqual(0);
      const handle = setSpy.mock.results[armedIdx].value;
      expect(clearSpy.mock.calls.some((c) => c[0] === handle)).toBe(true);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it("registers a once-only abort listener and detaches it on settle", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => res.end("ok"));

    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const fakeSignal = {
      aborted: false,
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal;

    // A not-yet-aborted signal must not abort the request — this resolves.
    const res = await safeFetch(
      `http://127.0.0.1:${port}/`,
      { signal: fakeSignal },
      allowLoopback,
    );
    expect(res.ok).toBe(true);

    expect(addEventListener).toHaveBeenCalledTimes(1);
    const [event, handler, options] = addEventListener.mock.calls[0];
    expect(event).toBe("abort");
    expect(options).toEqual({ once: true });
    // The SAME handler is detached on settle, so a long-lived caller signal can't pin the
    // request closure in memory (or fire into a finished request).
    expect(removeEventListener).toHaveBeenCalledWith("abort", handler);
  });

  it("propagates a mid-body connection reset as a rejection (response error handler)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => {
      res.writeHead(200, { "Content-Length": "10" });
      res.write("abc");
      setTimeout(() => res.socket?.destroy(), 20);
    });

    // The response stream errors mid-body (ECONNRESET). res.on("error") must route it into the
    // promise; the deadline backstop's message would NOT match this assertion.
    await expect(
      safeFetch(
        `http://127.0.0.1:${port}/`,
        {},
        { ...allowLoopback, deadlineMs: 3_000 },
      ),
    ).rejects.toThrow(/ECONNRESET|aborted|premature/i);
  }, 5_000);
});
