import { describe, it, expect } from "vitest";
import {
  TRANSIENT_RETRY_ATTEMPTS,
  TRANSIENT_RETRY_DELAY_MS,
  TRANSIENT_RPC_ERROR_PATTERN,
  isTransientStatus,
} from "../transient-policy";

describe("transient-policy", () => {
  it("retries exactly once, after a flat 150ms delay", () => {
    expect(TRANSIENT_RETRY_ATTEMPTS).toBe(1);
    expect(TRANSIENT_RETRY_DELAY_MS).toBe(150);
  });

  it("treats 502/503/504 as transient", () => {
    expect(isTransientStatus(502)).toBe(true);
    expect(isTransientStatus(503)).toBe(true);
    expect(isTransientStatus(504)).toBe(true);
  });

  it("does not treat 429 or 500 (or 2xx/4xx) as transient", () => {
    expect(isTransientStatus(429)).toBe(false);
    expect(isTransientStatus(500)).toBe(false);
    expect(isTransientStatus(200)).toBe(false);
    expect(isTransientStatus(404)).toBe(false);
  });

  it("the RPC error-message classifier matches the same gateway-blip vocabulary", () => {
    expect(TRANSIENT_RPC_ERROR_PATTERN.test("upstream connect error")).toBe(true);
    expect(
      TRANSIENT_RPC_ERROR_PATTERN.test("An invalid response was received from the upstream server")
    ).toBe(true);
    expect(TRANSIENT_RPC_ERROR_PATTERN.test("502 Bad Gateway")).toBe(true);
    expect(TRANSIENT_RPC_ERROR_PATTERN.test("constraint violated")).toBe(false);
  });
});
