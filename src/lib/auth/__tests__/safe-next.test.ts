import { describe, it, expect } from "vitest";
import { safeNext } from "../safe-next";

const BASE = "http://localhost:3000";

describe("safeNext", () => {
  it("returns the fallback for empty/missing input", () => {
    expect(safeNext(null, BASE)).toBe("/dashboard");
    expect(safeNext(undefined, BASE)).toBe("/dashboard");
    expect(safeNext("", BASE)).toBe("/dashboard");
    expect(safeNext(null, BASE, "/home")).toBe("/home");
  });

  it("passes through a same-origin path, preserving the query", () => {
    expect(safeNext("/invite/accept?token=abc", BASE)).toBe(
      "/invite/accept?token=abc"
    );
    expect(safeNext("/rubrics", BASE)).toBe("/rubrics");
  });

  it("rejects absolute URLs to another origin", () => {
    expect(safeNext("https://evil.com/phish", BASE)).toBe("/dashboard");
    expect(safeNext("http://localhost:3000.evil.com", BASE)).toBe("/dashboard");
  });

  it("rejects protocol-relative and control-character bypasses", () => {
    expect(safeNext("//evil.com", BASE)).toBe("/dashboard");
    // The URL parser strips the tab, turning this into "//evil.com".
    expect(safeNext("/\t/evil.com", BASE)).toBe("/dashboard");
    expect(safeNext("\\/evil.com", BASE)).toBe("/dashboard");
  });
});
