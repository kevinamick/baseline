import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Chainable supabaseAdmin stub: hasPendingInvitation reads
// .from("invitations").select().eq().is().gt() and awaits the chain directly
// (thenable). Args to from/eq/is/gt are captured via vi.hoisted mocks so
// assertions can pin the exact query shape; the chain object itself is built
// inside the vi.mock factory (not a module-scope const referenced by the
// factory) to sidestep Vitest's mock-hoisting TDZ trap.
const { mockFrom, mockEq, mockIs, mockGt, resultBox } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockEq: vi.fn(),
  mockIs: vi.fn(),
  mockGt: vi.fn(),
  resultBox: { current: { count: 0, error: null } as { count: number | null; error: unknown } },
}));

vi.mock("@/lib/supabase/admin", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (...args: unknown[]) => {
    mockEq(...args);
    return chain;
  };
  chain.is = (...args: unknown[]) => {
    mockIs(...args);
    return chain;
  };
  chain.gt = (...args: unknown[]) => {
    mockGt(...args);
    return chain;
  };
  chain.then = (resolve: (v: unknown) => void) => resolve(resultBox.current);
  return {
    supabaseAdmin: {
      from: (...args: unknown[]) => {
        mockFrom(...args);
        return chain;
      },
    },
  };
});

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));
vi.mock("@/lib/logging/server", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: mockLogError },
}));

import { hasPendingInvitation } from "../pending";

beforeEach(() => {
  vi.clearAllMocks();
  resultBox.current = { count: 0, error: null };
});

describe("hasPendingInvitation", () => {
  it("returns true when a pending, unexpired invitation matches the email", async () => {
    resultBox.current = { count: 1, error: null };
    await expect(hasPendingInvitation("invitee@acme.com")).resolves.toBe(true);
    expect(mockFrom).toHaveBeenCalledWith("invitations");
    expect(mockEq).toHaveBeenCalledWith("email", "invitee@acme.com");
    expect(mockIs).toHaveBeenCalledWith("accepted_at", null);
    expect(mockGt).toHaveBeenCalledWith("expires_at", expect.any(String));
  });

  it("returns false when no invitation matches", async () => {
    resultBox.current = { count: 0, error: null };
    await expect(hasPendingInvitation("nobody@acme.com")).resolves.toBe(false);
  });

  it("fails closed (false) and logs when the lookup errors", async () => {
    resultBox.current = { count: null, error: { message: "db down" } };
    await expect(hasPendingInvitation("invitee@acme.com")).resolves.toBe(
      false
    );
    expect(mockLogError).toHaveBeenCalledWith(
      "pending invitation lookup failed",
      expect.objectContaining({ event: "invitation.gate_lookup_failed" })
    );
  });
});
