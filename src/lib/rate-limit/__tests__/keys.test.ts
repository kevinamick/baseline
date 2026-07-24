import { describe, it, expect } from "vitest";
import { hashKey, normalizeEmail, windowStart } from "../keys";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  A@B.CoM ")).toBe("a@b.com");
  });

  it("is a no-op on an already-normal address", () => {
    expect(normalizeEmail("a@b.com")).toBe("a@b.com");
  });
});

describe("hashKey", () => {
  it("is sha256(surface:keytype:value) hex — pinned literal", () => {
    // sha256("signIn:email:a@b.com") — independently computed. Pinning the
    // literal (not re-deriving it here) catches a changed separator, dropped
    // component, or empty update() input.
    expect(hashKey("signIn", "email", "a@b.com")).toBe(
      "5425c249cf738ecd85d5f1e55296ef44c868430bb53e928b5044140625d4f5c8"
    );
  });

  it("keys differ across surface, keytype, and value", () => {
    const base = hashKey("signIn", "email", "a@b.com");
    expect(hashKey("signUp", "email", "a@b.com")).not.toBe(base);
    expect(hashKey("signIn", "ip", "a@b.com")).not.toBe(base);
    expect(hashKey("signIn", "email", "b@b.com")).not.toBe(base);
  });
});

describe("windowStart", () => {
  it("floors the instant to a multiple of windowMs, as ISO", () => {
    // 2023-11-14T22:15:23.456Z
    const now = 1_700_000_123_456;
    expect(windowStart(60_000, now)).toBe("2023-11-14T22:15:00.000Z");
    expect(windowStart(3_600_000, now)).toBe("2023-11-14T22:00:00.000Z");
  });

  it("returns the exact boundary at the start of a window", () => {
    expect(windowStart(60_000, 1_700_000_100_000)).toBe(
      "2023-11-14T22:15:00.000Z"
    );
  });
});
