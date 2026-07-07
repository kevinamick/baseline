import { describe, it, expect } from "vitest";
import { initials } from "../initials";

describe("initials", () => {
  it("takes the first letter of the first two words", () => {
    expect(initials("Acme Engineering")).toBe("AE");
    expect(initials("  Big  Red  Co ")).toBe("BR");
  });

  it("takes the first two letters of a single word", () => {
    expect(initials("acme")).toBe("AC");
  });

  it("uses the local part of an email", () => {
    expect(initials("owner@acme.com")).toBe("OW");
    expect(initials("jane.doe@example.com")).toBe("JD");
  });

  it("treats . _ - as word separators", () => {
    expect(initials("jane_doe")).toBe("JD");
    expect(initials("jane-doe")).toBe("JD");
  });

  it("falls back to ? for empty input", () => {
    expect(initials(null)).toBe("?");
    expect(initials(undefined)).toBe("?");
    expect(initials("   ")).toBe("?");
  });
});
