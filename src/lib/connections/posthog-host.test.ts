import { describe, it, expect } from "vitest";
import { isAllowedPosthogHostUrl, POSTHOG_HOST_MESSAGE } from "./posthog-host";

describe("isAllowedPosthogHostUrl", () => {
  it("accepts PostHog Cloud hosts", () => {
    for (const url of [
      "https://us.posthog.com",
      "https://eu.posthog.com",
      "https://app.posthog.com",
      "https://us.posthog.com/", // trailing slash
      "  https://eu.posthog.com  ", // trimmed
    ]) {
      expect(isAllowedPosthogHostUrl(url), url).toBe(true);
    }
  });

  it("rejects non-PostHog hosts, look-alikes, and unparseable input", () => {
    for (const url of [
      "https://evil.example.com",
      "https://posthog.com.attacker.example",
      "https://evilposthog.com",
      "not a url",
      "",
    ]) {
      expect(isAllowedPosthogHostUrl(url), url).toBe(false);
    }
  });

  it("exposes a human-readable message", () => {
    expect(POSTHOG_HOST_MESSAGE).toMatch(/posthog\.com/);
  });
});
