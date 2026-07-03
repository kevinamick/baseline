import { describe, it, expect, afterEach, vi } from "vitest";
import { buildCsp } from "../csp";

const NONCE = "test-nonce-123";

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
