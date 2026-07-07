import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// vi.hoisted: referenced inside the hoisted vi.mock factory below.
const { mockFrom, mockUpdate, mockEq, mockIs, mockLogError, resultBox } =
  vi.hoisted(() => ({
    mockFrom: vi.fn(),
    mockUpdate: vi.fn(),
    mockEq: vi.fn(),
    mockIs: vi.fn(),
    mockLogError: vi.fn(),
    resultBox: { current: { error: null as unknown } },
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
  resultBox.current = { error: null };
});

describe("bindFirstTeamAccessCodeRedemption", () => {
  it("stamps the redeemer's unbound redemption with the Team id, guarded on org_id IS NULL", async () => {
    await bindFirstTeamAccessCodeRedemption("user-1", "org-1");

    expect(mockFrom).toHaveBeenCalledWith("access_code_redemptions");
    expect(mockUpdate).toHaveBeenCalledWith({ org_id: "org-1" });
    expect(mockEq).toHaveBeenCalledWith("user_id", "user-1");
    expect(mockIs).toHaveBeenCalledWith("org_id", null);
  });

  it("is a no-op (0 rows matched) for a second Team — the guard, not a branch here, restricts it", async () => {
    // No special assertion needed beyond the query shape above: the guard
    // living in the WHERE clause means a second call for the same user
    // simply matches nothing once the first call cleared org_id's null.
    // This test documents that the function never inspects "is this the
    // first Team" — it always issues the same guarded update.
    resultBox.current = { error: null };
    await expect(
      bindFirstTeamAccessCodeRedemption("user-1", "org-2")
    ).resolves.toBeUndefined();
    expect(mockEq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("swallows (logs, doesn't throw) an update error", async () => {
    resultBox.current = { error: { message: "boom" } };
    await expect(
      bindFirstTeamAccessCodeRedemption("user-1", "org-1")
    ).resolves.toBeUndefined();
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
