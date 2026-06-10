// Pins the cookie → distinct_id extraction used by onRequestError (src/instrumentation.ts)
// to attribute server-side exceptions to the same person posthog-js tracks client-side.

import { describe, it, expect } from "vitest";
import { distinctIdFromCookieHeader } from "../posthog-cookie";

const PH_COOKIE_NAME = "ph_phc_abc123_posthog";

function phCookie(payload: unknown): string {
  return `${PH_COOKIE_NAME}=${encodeURIComponent(JSON.stringify(payload))}`;
}

describe("distinctIdFromCookieHeader", () => {
  it("extracts distinct_id from the PostHog cookie", () => {
    const header = `other=1; ${phCookie({ distinct_id: "user_42" })}; theme=dark`;
    expect(distinctIdFromCookieHeader(header)).toBe("user_42");
  });

  it("returns null when there is no cookie header", () => {
    expect(distinctIdFromCookieHeader(undefined)).toBeNull();
  });

  it("returns null when the PostHog cookie is absent", () => {
    expect(distinctIdFromCookieHeader("session=abc; theme=dark")).toBeNull();
  });

  it("normalizes an array cookie header", () => {
    const header = ["session=abc", phCookie({ distinct_id: "user_7" })];
    expect(distinctIdFromCookieHeader(header)).toBe("user_7");
  });

  it("swallows malformed JSON", () => {
    expect(
      distinctIdFromCookieHeader(`${PH_COOKIE_NAME}=${encodeURIComponent("{not json")}`)
    ).toBeNull();
  });

  it("returns null when the payload has no usable distinct_id", () => {
    expect(distinctIdFromCookieHeader(phCookie({ distinct_id: "" }))).toBeNull();
    expect(distinctIdFromCookieHeader(phCookie({ distinct_id: 7 }))).toBeNull();
    expect(distinctIdFromCookieHeader(phCookie({}))).toBeNull();
  });
});
