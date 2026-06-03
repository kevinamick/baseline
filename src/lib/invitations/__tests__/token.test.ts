import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { generateToken, hashToken } from "../token";

describe("invitation token", () => {
  it("generates a unique, URL-safe token each call", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet
    expect(a.length).toBeGreaterThanOrEqual(40);
  });

  it("hashes deterministically to a sha256 hex string", () => {
    expect(hashToken("token")).toEqual(hashToken("token"));
    expect(hashToken("token")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes different tokens to different digests", () => {
    expect(hashToken("a")).not.toEqual(hashToken("b"));
  });
});
