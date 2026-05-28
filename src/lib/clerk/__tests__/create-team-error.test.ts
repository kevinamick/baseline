import { describe, it, expect, vi } from "vitest";

const mockIsClerkAPIResponseError = vi.fn();
vi.mock("@clerk/nextjs/errors", () => ({
  isClerkAPIResponseError: (err: unknown) => mockIsClerkAPIResponseError(err),
}));

import { createTeamErrorMessage } from "../create-team-error";

const FALLBACK = "Something went wrong creating your team. Please try again.";

describe("createTeamErrorMessage", () => {
  it("prefers longMessage from a Clerk API error", () => {
    mockIsClerkAPIResponseError.mockReturnValue(true);
    const err = {
      errors: [{ code: "x", message: "short", longMessage: "the long one" }],
    };
    expect(createTeamErrorMessage(err)).toBe("the long one");
  });

  it("falls back to message when longMessage is absent", () => {
    mockIsClerkAPIResponseError.mockReturnValue(true);
    const err = { errors: [{ code: "x", message: "just the message" }] };
    expect(createTeamErrorMessage(err)).toBe("just the message");
  });

  it("returns the generic fallback for a Clerk error with no entries", () => {
    mockIsClerkAPIResponseError.mockReturnValue(true);
    expect(createTeamErrorMessage({ errors: [] })).toBe(FALLBACK);
  });

  it("returns the generic fallback for non-Clerk errors (e.g. network)", () => {
    mockIsClerkAPIResponseError.mockReturnValue(false);
    expect(createTeamErrorMessage(new Error("network down"))).toBe(FALLBACK);
  });
});
