import { describe, it, expect, afterEach, vi } from "vitest";
import {
  endpointUrlError,
  isAllowedEndpointUrl,
  ENDPOINT_HTTPS_MESSAGE,
  ENDPOINT_USERINFO_MESSAGE,
  ENDPOINT_INTERNAL_MESSAGE,
} from "./endpoint";

// vitest sets NODE_ENV=test (not "development"), so http is refused by default — matching
// production behavior. The dev-only http allowance is exercised explicitly via stubEnv.
afterEach(() => vi.unstubAllEnvs());

describe("endpointUrlError — accepted endpoints", () => {
  const ok = [
    "https://api.example.com/run",
    "https://api.example.com:8443/v1/agent",
    "https://sub.domain.example.co.uk/path?q=1",
    "  https://api.example.com/run  ", // trimmed
    "https://1.1.1.1/", // public IPv4 literal
    "https://8.8.8.8:443/resolve", // public IPv4 literal w/ port
    "https://[2606:4700:4700::1111]/", // public IPv6 literal
  ];
  for (const url of ok) {
    it(`accepts ${url.trim()}`, () => {
      expect(endpointUrlError(url)).toBeNull();
      expect(isAllowedEndpointUrl(url)).toBe(true);
    });
  }
});

describe("endpointUrlError — scheme", () => {
  it("rejects http outside development", () => {
    expect(endpointUrlError("http://api.example.com/")).toBe(ENDPOINT_HTTPS_MESSAGE);
  });

  it("rejects non-http(s) schemes", () => {
    expect(endpointUrlError("ftp://api.example.com/")).toBe(ENDPOINT_HTTPS_MESSAGE);
    expect(endpointUrlError("file:///etc/passwd")).toBe(ENDPOINT_HTTPS_MESSAGE);
  });

  it("allows http in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(endpointUrlError("http://api.example.com/")).toBeNull();
  });

  it("still rejects an internal http target in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(endpointUrlError("http://127.0.0.1:8080/")).toBe(ENDPOINT_INTERNAL_MESSAGE);
    expect(endpointUrlError("http://localhost:3000/")).toBe(ENDPOINT_INTERNAL_MESSAGE);
  });
});

describe("endpointUrlError — userinfo", () => {
  for (const url of [
    "https://user:pass@api.example.com/",
    "https://user@api.example.com/",
  ]) {
    it(`rejects credentials in ${url}`, () => {
      expect(endpointUrlError(url)).toBe(ENDPOINT_USERINFO_MESSAGE);
    });
  }
});

describe("endpointUrlError — internal hostnames", () => {
  const internal = [
    "https://localhost/",
    "https://localhost:3000/api",
    "https://app.localhost/",
    "https://printer.local/",
    "https://vault.internal/",
    "https://metadata.google.internal/computeMetadata/v1/",
    // Trailing-dot FQDNs resolve to the same host and must not bypass the name match.
    "https://localhost./",
    "https://printer.local./",
  ];
  for (const url of internal) {
    it(`rejects ${url}`, () => {
      expect(endpointUrlError(url)).toBe(ENDPOINT_INTERNAL_MESSAGE);
    });
  }
});

describe("endpointUrlError — private/reserved IP literals", () => {
  const blocked = [
    "https://127.0.0.1/",
    "https://10.0.0.5/internal",
    "https://192.168.1.1/",
    "https://172.16.0.1/",
    "https://169.254.169.254/latest/meta-data/", // cloud metadata
    "https://[::1]/", // IPv6 loopback
    "https://[::ffff:169.254.169.254]/", // IPv4-mapped metadata
    "https://[2002:7f00:1::]/", // 6to4-tunneled 127.0.0.1
    "https://0.0.0.0/",
    // The WHATWG URL parser canonicalizes encoded IPv4 to dotted-decimal, so the classifier
    // still sees 127.0.0.1 and these obfuscated forms are caught too.
    "https://2130706433/", // decimal for 127.0.0.1
    "https://0x7f.0.0.1/", // hex octet for 127.0.0.1
  ];
  for (const url of blocked) {
    it(`rejects ${url}`, () => {
      expect(endpointUrlError(url)).toBe(ENDPOINT_INTERNAL_MESSAGE);
      expect(isAllowedEndpointUrl(url)).toBe(false);
    });
  }
});

describe("endpointUrlError — malformed", () => {
  for (const raw of ["not a url", "", "   ", "://missing-scheme"]) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      expect(endpointUrlError(raw)).not.toBeNull();
      expect(isAllowedEndpointUrl(raw)).toBe(false);
    });
  }
});
