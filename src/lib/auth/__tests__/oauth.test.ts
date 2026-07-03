import { describe, it, expect, afterEach } from "vitest";
import {
  OAUTH_PROVIDERS,
  OAUTH_PROVIDER_LABELS,
  isOAuthProvider,
  enabledOAuthProviders,
} from "../oauth";

const ORIGINAL_ENV = process.env.NEXT_PUBLIC_OAUTH_PROVIDERS;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.NEXT_PUBLIC_OAUTH_PROVIDERS;
  } else {
    process.env.NEXT_PUBLIC_OAUTH_PROVIDERS = ORIGINAL_ENV;
  }
});

describe("isOAuthProvider", () => {
  it("accepts every provider in OAUTH_PROVIDERS", () => {
    for (const p of OAUTH_PROVIDERS) {
      expect(isOAuthProvider(p)).toBe(true);
    }
  });

  it("rejects an unknown string", () => {
    expect(isOAuthProvider("facebook")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isOAuthProvider(undefined)).toBe(false);
    expect(isOAuthProvider(null)).toBe(false);
    expect(isOAuthProvider(42)).toBe(false);
    expect(isOAuthProvider({})).toBe(false);
  });
});

describe("enabledOAuthProviders", () => {
  it("returns an empty list when the env var is unset (clean local dev default)", () => {
    delete process.env.NEXT_PUBLIC_OAUTH_PROVIDERS;
    expect(enabledOAuthProviders()).toEqual([]);
  });

  it("returns an empty list when the env var is empty", () => {
    process.env.NEXT_PUBLIC_OAUTH_PROVIDERS = "";
    expect(enabledOAuthProviders()).toEqual([]);
  });

  it("parses a single configured provider", () => {
    process.env.NEXT_PUBLIC_OAUTH_PROVIDERS = "google";
    expect(enabledOAuthProviders()).toEqual(["google"]);
  });

  it("parses multiple comma-separated providers, trimming whitespace", () => {
    process.env.NEXT_PUBLIC_OAUTH_PROVIDERS = "google, github";
    expect(enabledOAuthProviders()).toEqual(["google", "github"]);
  });

  it("ignores unrecognized entries", () => {
    process.env.NEXT_PUBLIC_OAUTH_PROVIDERS = "google,facebook";
    expect(enabledOAuthProviders()).toEqual(["google"]);
  });

  it("preserves the canonical OAUTH_PROVIDERS order regardless of env order", () => {
    process.env.NEXT_PUBLIC_OAUTH_PROVIDERS = "github,google";
    expect(enabledOAuthProviders()).toEqual(["google", "github"]);
  });
});

describe("OAUTH_PROVIDER_LABELS", () => {
  it("has a human label for every provider", () => {
    for (const p of OAUTH_PROVIDERS) {
      expect(typeof OAUTH_PROVIDER_LABELS[p]).toBe("string");
      expect(OAUTH_PROVIDER_LABELS[p].length).toBeGreaterThan(0);
    }
  });
});
