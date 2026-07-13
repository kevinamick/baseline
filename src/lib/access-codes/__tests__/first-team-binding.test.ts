import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// vi.hoisted: referenced inside the hoisted vi.mock factory below.
const { mockFrom, mockUpdate, mockEq, mockIs, mockSelect, mockLogError, resultBox } =
  vi.hoisted(() => ({
    mockFrom: vi.fn(),
    mockUpdate: vi.fn(),
    mockEq: vi.fn(),
    mockIs: vi.fn(),
    mockSelect: vi.fn(),
    mockLogError: vi.fn(),
    resultBox: { current: { data: [] as unknown, error: null as unknown } },
  }));

vi.mock("@/lib/supabase/admin", () => {
  const chain: Record<string, unknown> = {};
  chain.update = (...args: unknown[]) => {
    mockUpdate(...args);
    return chain;
  };
  chain.eq = (...args: unknown[]) => {
    mockEq(...args);
    return chain;
  };
  chain.is = (...args: unknown[]) => {
    mockIs(...args);
    return chain;
  };
  chain.select = (...args: unknown[]) => {
    mockSelect(...args);
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
vi.mock("@/lib/logging/server", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: mockLogError },
}));

import { bindFirstTeamAccessCodeRedemption } from "../first-team-binding";

beforeEach(() => {
  vi.clearAllMocks();
  resultBox.current = { data: [], error: null };
});

describe("bindFirstTeamAccessCodeRedemption", () => {
  it("stamps the redeemer's unbound redemption with the Team id, guarded on org_id IS NULL, and reports the bind", async () => {
    resultBox.current = { data: [{ access_code_id: "code-1" }], error: null };
    const bound = await bindFirstTeamAccessCodeRedemption("user-1", "org-1");

    expect(mockFrom).toHaveBeenCalledWith("access_code_redemptions");
    expect(mockUpdate).toHaveBeenCalledWith({ org_id: "org-1" });
    expect(mockEq).toHaveBeenCalledWith("user_id", "user-1");
    expect(mockIs).toHaveBeenCalledWith("org_id", null);
    // Selecting the affected rows is what lets the caller tell a real bind
    // (a code redeemer's first Team) from a no-op.
    expect(mockSelect).toHaveBeenCalledWith("access_code_id");
    expect(bound).toBe(true);
  });

  it("returns false (0 rows matched) for a second Team or an ungated creator — the guard, not a branch here, restricts it", async () => {
    // The guard living in the WHERE clause means a second call for the same
    // user simply matches nothing once the first call cleared org_id's null;
    // an ungated creator has no redemption row at all. Both surface as an
    // empty result set, which the caller reads as "keep the default landing."
    // This test documents that the function never inspects "is this the first
    // Team" — it always issues the same guarded update and reports the count.
    resultBox.current = { data: [], error: null };
    await expect(
      bindFirstTeamAccessCodeRedemption("user-1", "org-2")
    ).resolves.toBe(false);
    expect(mockEq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("swallows (logs, returns false) an update error", async () => {
    resultBox.current = { data: null, error: { message: "boom" } };
    await expect(
      bindFirstTeamAccessCodeRedemption("user-1", "org-1")
    ).resolves.toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      "access code first-Team binding failed",
      {
        event: "access_code.first_team_bind_failed",
        user_id: "user-1",
        org_id: "org-1",
        error: { message: "boom" },
      }
    );
  });
});
