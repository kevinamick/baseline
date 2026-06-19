import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { safeFetch, assertSafeUrl, BlockedRequestError } from "./safe-fetch.js";

// The address classifier (isBlockedAddress / isBlockedIpLiteral) now lives in ip-ranges.ts
// and is covered by ip-ranges.test.ts. This file covers the URL policy + transport.

describe("assertSafeUrl", () => {
  it("accepts an https URL", () => {
    expect(assertSafeUrl("https://api.example.com/x").hostname).toBe("api.example.com");
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow(BlockedRequestError);
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
});

describe("safeFetch egress policy (no connection made)", () => {
  // Literal IPs resolve offline, so these never touch the network. https keeps the scheme
  // check happy under NODE_ENV=test.
  it("blocks the cloud metadata IP", async () => {
    await expect(safeFetch("https://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /blocked address 169\.254\.169\.254/
    );
  });

  it("blocks loopback", async () => {
    await expect(safeFetch("https://127.0.0.1/")).rejects.toBeInstanceOf(BlockedRequestError);
  });

  it("blocks an IPv4-mapped IPv6 metadata address", async () => {
    await expect(safeFetch("https://[::ffff:169.254.169.254]/")).rejects.toThrow(
      BlockedRequestError
    );
  });

  it("blocks an RFC1918 literal", async () => {
    await expect(safeFetch("https://10.0.0.5/")).rejects.toThrow(BlockedRequestError);
  });

  it("blocks when a public hostname resolves to a private address (DNS rebinding)", async () => {
    // The attack: a public-looking hostname whose A record points inside the perimeter.
    // safeFetch validates the resolved address and refuses before connecting.
    const lookupAll = async () => [{ address: "10.1.2.3", family: 4 }];
    await expect(
      safeFetch("https://rebind.evil.test/", {}, { lookupAll })
    ).rejects.toThrow(/blocked address 10\.1\.2\.3/);
  });

  it("refuses to connect when DNS returns no addresses", async () => {
    await expect(
      safeFetch("https://void.test/", {}, { lookupAll: async () => [] })
    ).rejects.toThrow(/No addresses/);
  });
});

describe("safeFetch transport (loopback server)", () => {
  let server: Server;
  let received: IncomingMessage[] = [];
  let port = 0;

  // Permit loopback so we can exercise the real transport, and allow http via the dev env.
  // The egress policy itself is covered separately above.
  const allowLoopback = { isBlocked: () => false };

  function start(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<void> {
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

    const res = await safeFetch(`http://127.0.0.1:${port}/data`, {}, allowLoopback);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world" });
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
        headers: { "Content-Type": "application/json", Authorization: "Bearer s3cr3t" },
        body: JSON.stringify({ query: 1 }),
      },
      allowLoopback
    );

    const req = received[0];
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe("Bearer s3cr3t");
    expect(body).toBe(JSON.stringify({ query: 1 }));
  });

  it("refuses a 3xx redirect and never fetches the redirect target", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });

    await expect(
      safeFetch(`http://127.0.0.1:${port}/redirect`, {}, allowLoopback)
    ).rejects.toThrow(/Refusing to follow redirect/);
    // Only the original request reached our server; the redirect target was never fetched.
    expect(received).toHaveLength(1);
  });

  it("pins to the validated IP while preserving the original Host header (rebinding-proof)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await start((_req, res) => res.end("ok"));

    // The URL hostname is a name, but we hand safeFetch the validated loopback IP. The socket
    // connects to that pinned IP (no re-resolution), yet the Host header carries the hostname.
    await safeFetch(
      `http://pinned.example.test:${port}/`,
      {},
      { isBlocked: () => false, lookupAll: async () => [{ address: "127.0.0.1", family: 4 }] }
    );

    expect(received).toHaveLength(1);
    expect(received[0].headers.host).toBe(`pinned.example.test:${port}`);
  });
});
