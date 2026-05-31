import { describe, it, expect } from "vitest";
import { normalizeEmail } from "./email-tags-field";

describe("normalizeEmail", () => {
  it("returns a valid address unchanged", () => {
    expect(normalizeEmail("user@example.com")).toBe("user@example.com");
  });

  it("trims surrounding whitespace and a trailing comma", () => {
    expect(normalizeEmail("  user@example.com,  ")).toBe("user@example.com");
    expect(normalizeEmail("user@example.com,")).toBe("user@example.com");
  });

  it("rejects values that aren't a well-formed address", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("missing@domain")).toBeNull();
    expect(normalizeEmail("@example.com")).toBeNull();
    expect(normalizeEmail("user@")).toBeNull();
    expect(normalizeEmail("a b@example.com")).toBeNull();
  });
});
