// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  CONSENT_COOKIE,
  parseConsent,
  readConsent,
  writeConsent,
  analyticsAllowed,
} from "../cookie";

function clearCookies() {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
}

beforeEach(clearCookies);

describe("parseConsent", () => {
  it("returns null when the cookie is absent", () => {
    expect(parseConsent("other=1; foo=bar")).toBeNull();
    expect(parseConsent("")).toBeNull();
  });

  it("reads a valid choice regardless of surrounding cookies", () => {
    expect(parseConsent(`a=1; ${CONSENT_COOKIE}=accepted; b=2`)).toBe(
      "accepted",
    );
    expect(parseConsent(`${CONSENT_COOKIE}=rejected`)).toBe("rejected");
  });

  it("rejects an unknown/tampered value", () => {
    expect(parseConsent(`${CONSENT_COOKIE}=maybe`)).toBeNull();
    expect(parseConsent(`${CONSENT_COOKIE}=`)).toBeNull();
  });
});

describe("readConsent / writeConsent / analyticsAllowed", () => {
  it("starts with no choice and disallows analytics by default (opt-in)", () => {
    expect(readConsent()).toBeNull();
    expect(analyticsAllowed()).toBe(false);
  });

  it("round-trips an accepted choice and allows analytics", () => {
    writeConsent("accepted");
    expect(readConsent()).toBe("accepted");
    expect(analyticsAllowed()).toBe(true);
  });

  it("round-trips a rejected choice and disallows analytics", () => {
    writeConsent("rejected");
    expect(readConsent()).toBe("rejected");
    expect(analyticsAllowed()).toBe(false);
  });
});
