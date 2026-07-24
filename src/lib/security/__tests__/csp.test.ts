import { describe, it, expect, afterEach, vi } from "vitest";
import { buildCsp } from "../csp";

const NONCE = "test-nonce-123";

/**
 * Pin every ambient env var buildCsp reads, so the exact-string tests below
 * are deterministic regardless of the machine's .env.
 */
function stubBaseEnv(nodeEnv: "production" | "development") {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildCsp", () => {
  it("includes the nonce and strict-dynamic in script-src", () => {
    vi.stubEnv("NODE_ENV", "production");
    const csp = buildCsp(NONCE);
    expect(csp).toContain(`'nonce-${NONCE}'`);
    expect(csp).toContain("'strict-dynamic'");
  });

  it("appends upgrade-insecure-requests and omits unsafe-eval in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const csp = buildCsp(NONCE);
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("allows unsafe-eval and skips the HTTPS upgrade outside production (dev HMR)", () => {
    vi.stubEnv("NODE_ENV", "development");
    const csp = buildCsp(NONCE);
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("adds the Supabase origin (http+ws) to connect-src when configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abcdefgh.supabase.co");
    const csp = buildCsp(NONCE);
    const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
    expect(connectSrc).toContain("https://abcdefgh.supabase.co");
    expect(connectSrc).toContain("wss://abcdefgh.supabase.co");
  });

  it("omits Supabase origins from connect-src when the env var is unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    const csp = buildCsp(NONCE);
    const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
    expect(connectSrc).toBe("connect-src 'self'");
  });

  it("falls through cleanly when NEXT_PUBLIC_SUPABASE_URL is malformed", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "not-a-valid-url");
    const csp = buildCsp(NONCE);
    const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
    expect(connectSrc).toBe("connect-src 'self'");
  });

  it("adds vercel.live and Pusher origins only on Vercel preview deployments", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");
    const csp = buildCsp(NONCE);
    expect(csp).toContain("https://vercel.live");
    expect(csp).toContain("https://vercel.com");
    expect(csp).toContain("https://assets.vercel.com");
    expect(csp).toContain("wss://ws-us3.pusher.com");
    expect(csp).toContain("https://*.pusher.com");
  });

  it("omits preview-only origins outside of a Vercel preview deployment", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    const csp = buildCsp(NONCE);
    expect(csp).not.toContain("vercel.live");
    expect(csp).not.toContain("pusher.com");
  });

  it("admits the GA4 hosts to script-src/connect-src/img-src when NEXT_PUBLIC_GA_MEASUREMENT_ID is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", "G-TEST12345");
    const csp = buildCsp(NONCE);
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
    const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
    const imgSrc = csp.split("; ").find((d) => d.startsWith("img-src"));
    expect(scriptSrc).toContain("https://*.googletagmanager.com");
    expect(connectSrc).toContain("https://*.googletagmanager.com");
    expect(connectSrc).toContain("https://*.google-analytics.com");
    expect(imgSrc).toContain("https://*.google-analytics.com");
  });

  it("omits the GA4 hosts entirely when NEXT_PUBLIC_GA_MEASUREMENT_ID is unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", "");
    const csp = buildCsp(NONCE);
    expect(csp).not.toContain("googletagmanager.com");
    expect(csp).not.toContain("google-analytics.com");
  });

  // Exact-policy pins: any dropped directive, dropped host, or reordered value
  // in a canonical configuration fails these byte-for-byte assertions.

  it("builds exactly the locked-down policy in production with no optional origins", () => {
    stubBaseEnv("production");
    expect(buildCsp(NONCE)).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "frame-src 'self' https://www.youtube-nocookie.com",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "upgrade-insecure-requests",
      ].join("; ")
    );
  });

  it("builds exactly the dev policy (unsafe-eval added, no HTTPS upgrade)", () => {
    stubBaseEnv("development");
    expect(buildCsp(NONCE)).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic' 'unsafe-eval'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "frame-src 'self' https://www.youtube-nocookie.com",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "base-uri 'self'",
        "object-src 'none'",
      ].join("; ")
    );
  });

  it("builds exactly the Vercel-preview policy (Live toolbar + Pusher origins)", () => {
    stubBaseEnv("production");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(buildCsp(NONCE)).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic' https://vercel.live`,
        "style-src 'self' 'unsafe-inline' https://vercel.live",
        "img-src 'self' data: blob: https://vercel.live https://vercel.com",
        "font-src 'self' data: https://assets.vercel.com",
        "connect-src 'self' https://vercel.live wss://ws-us3.pusher.com https://*.pusher.com",
        "worker-src 'self' blob:",
        "frame-src 'self' https://www.youtube-nocookie.com https://vercel.live",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "upgrade-insecure-requests",
      ].join("; ")
    );
  });

  it("builds exactly the GA4-enabled policy (hosts in script/connect/img only)", () => {
    stubBaseEnv("production");
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", "G-TEST12345");
    expect(buildCsp(NONCE)).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic' https://*.googletagmanager.com`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https://*.google-analytics.com",
        "font-src 'self' data:",
        "connect-src 'self' https://*.googletagmanager.com https://*.google-analytics.com",
        "worker-src 'self' blob:",
        "frame-src 'self' https://www.youtube-nocookie.com",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "upgrade-insecure-requests",
      ].join("; ")
    );
  });

  it("pins the Supabase connect-src entries exactly (https origin + ws twin)", () => {
    stubBaseEnv("production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abcdefgh.supabase.co");
    const connectSrc = buildCsp(NONCE)
      .split("; ")
      .find((d) => d.startsWith("connect-src"));
    expect(connectSrc).toBe(
      "connect-src 'self' https://abcdefgh.supabase.co wss://abcdefgh.supabase.co"
    );
  });

  it("rewrites only the scheme to ws, never an http-looking host", () => {
    // The http→ws rewrite must stay anchored to the start of the origin: a
    // host that merely contains "http" is left alone.
    stubBaseEnv("production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "ws://http.supabase.internal");
    const connectSrc = buildCsp(NONCE)
      .split("; ")
      .find((d) => d.startsWith("connect-src"));
    expect(connectSrc).toBe(
      "connect-src 'self' ws://http.supabase.internal ws://http.supabase.internal"
    );
  });

  it("always sets the fixed baseline directives", () => {
    vi.stubEnv("NODE_ENV", "production");
    const csp = buildCsp(NONCE);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("worker-src 'self' blob:");
  });
});
