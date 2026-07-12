import { describe, it, expect } from "vitest";
import { parseIgnoreList, isIgnored } from "./ignore-list.ts";

describe("parseIgnoreList", () => {
  it("parses a valid ignore-list array", () => {
    const entries = parseIgnoreList(
      JSON.stringify([
        { provider: "anthropic", id: "claude-2.1", reason: "old snapshot" },
        { provider: "openai", id: "gpt-4-vision-preview" },
      ])
    );
    expect(entries).toEqual([
      { provider: "anthropic", id: "claude-2.1", reason: "old snapshot" },
      { provider: "openai", id: "gpt-4-vision-preview", reason: undefined },
    ]);
  });

  it("accepts an empty array", () => {
    expect(parseIgnoreList("[]")).toEqual([]);
  });

  it("throws on a non-array root", () => {
    expect(() => parseIgnoreList(JSON.stringify({ id: "x" }))).toThrow(/must be a JSON array/);
  });

  it("throws when an entry is missing provider or id", () => {
    expect(() => parseIgnoreList(JSON.stringify([{ id: "x" }]))).toThrow(
      /must have string "provider" and "id"/
    );
    expect(() => parseIgnoreList(JSON.stringify([{ provider: "openai" }]))).toThrow(
      /must have string "provider" and "id"/
    );
  });

  it("throws when an entry is not an object", () => {
    expect(() => parseIgnoreList(JSON.stringify(["oops"]))).toThrow(/must be an object/);
  });
});

describe("isIgnored", () => {
  const entries = [
    { provider: "anthropic" as const, id: "claude-2.1" },
    { provider: "openai" as const, id: "gpt-4-vision-preview" },
  ];

  it("matches on provider + id", () => {
    expect(isIgnored(entries, "anthropic", "claude-2.1")).toBe(true);
    expect(isIgnored(entries, "openai", "gpt-4-vision-preview")).toBe(true);
  });

  it("does not match across providers even with the same id string", () => {
    expect(isIgnored(entries, "google", "claude-2.1")).toBe(false);
  });

  it("does not match an id that isn't in the list", () => {
    expect(isIgnored(entries, "anthropic", "claude-sonnet-4-6")).toBe(false);
  });
});
