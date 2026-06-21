import { describe, it, expect } from "vitest";
import { isAllowedPosthogHost, isAllowedPosthogUrl } from "./posthog-hosts.js";

describe("isAllowedPosthogHost", () => {
  it("accepts posthog.com and its subdomains", () => {
    for (const host of [
      "posthog.com",
      "us.posthog.com",
      "eu.posthog.com",
      "app.posthog.com",
      "US.PostHog.com", // case-insensitive
      "us.posthog.com.", // trailing dot (FQDN form)
    ]) {
      expect(isAllowedPosthogHost(host), host).toBe(true);
    }
  });

  it("rejects non-PostHog and look-alike hosts", () => {
    for (const host of [
      "evil.example.com",
      "posthog.com.attacker.example", // suffix-confusion: not under posthog.com
      "evilposthog.com", // no dot before posthog → not a subdomain
      "notposthog.com",
      "169.254.169.254",
      "",
    ]) {
      expect(isAllowedPosthogHost(host), host).toBe(false);
    }
  });
});

describe("isAllowedPosthogUrl", () => {
  it("accepts a well-formed PostHog URL", () => {
    expect(isAllowedPosthogUrl("https://us.posthog.com")).toBe(true);
    expect(isAllowedPosthogUrl("  https://eu.posthog.com/  ")).toBe(true);
  });

  it("rejects non-PostHog URLs and unparseable input", () => {
    expect(isAllowedPosthogUrl("https://evil.example.com")).toBe(false);
    expect(isAllowedPosthogUrl("not a url")).toBe(false);
  });
});
