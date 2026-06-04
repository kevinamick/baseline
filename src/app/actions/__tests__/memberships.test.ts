import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetAuthContext,
  mockTrack,
  mockRevalidate,
  mockMemberRole,
  mockAdminCount,
  mockUpdate,
  mockUpdateArgs,
  mockDelete,
} = vi.hoisted(() => ({
  mockGetAuthContext: vi.fn(),
  mockTrack: vi.fn(),
  mockRevalidate: vi.fn(),
  mockMemberRole: vi.fn(),
  mockAdminCount: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateArgs: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));

// Chainable stub: intermediate methods return the node; `maybeSingle` and an
// awaited node both resolve `result()`. The admin-count select is told apart
// from the role select by its `{ head: true }` option.
vi.mock("@/lib/supabase/admin", () => {
  function chain(result: () => unknown): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    c.eq = () => c;
    c.maybeSingle = () => Promise.resolve(result());
    c.then = (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(onF, onR);
    return c;
  }
  return {
    supabaseAdmin: {
      from: () => ({
        select: (_cols: unknown, opts?: { head?: boolean }) =>
          opts?.head ? chain(() => mockAdminCount()) : chain(() => mockMemberRole()),
        update: (payload: unknown) => {
          mockUpdateArgs(payload);
          return chain(() => mockUpdate());
        },
        delete: () => chain(() => mockDelete()),
      }),
    },
  };
});

import { changeMemberRole, removeMember } from "../memberships";

function fd(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue({
    userId: "admin-1",
    orgId: "org-1",
    role: "admin",
    canWrite: true,
  });
  mockMemberRole.mockResolvedValue({ data: { role: "member" } });
  mockAdminCount.mockResolvedValue({ count: 2 });
  mockUpdate.mockResolvedValue({ error: null });
  mockDelete.mockResolvedValue({ error: null });
});

describe("changeMemberRole", () => {
  it("promotes a member to admin", async () => {
    await changeMemberRole(fd({ userId: "u-2", role: "admin" }));
    expect(mockUpdateArgs).toHaveBeenCalledWith({ role: "admin" });
    expect(mockTrack).toHaveBeenCalledWith(
      { name: "membership.role_changed", props: { team_id: "org-1", role: "admin" } },
      { userId: "admin-1" }
    );
    expect(mockRevalidate).toHaveBeenCalledWith("/settings/team");
  });

  it("demotes an admin when another admin remains", async () => {
    mockMemberRole.mockResolvedValue({ data: { role: "admin" } });
    mockAdminCount.mockResolvedValue({ count: 2 });
    await changeMemberRole(fd({ userId: "u-2", role: "member" }));
    expect(mockUpdateArgs).toHaveBeenCalledWith({ role: "member" });
  });

  it("refuses to demote the last admin", async () => {
    mockMemberRole.mockResolvedValue({ data: { role: "admin" } });
    mockAdminCount.mockResolvedValue({ count: 1 });
    await changeMemberRole(fd({ userId: "u-2", role: "member" }));
    expect(mockUpdateArgs).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("does nothing for non-admins", async () => {
    mockGetAuthContext.mockResolvedValue({
      userId: "u-2",
      orgId: "org-1",
      canWrite: false,
    });
    await changeMemberRole(fd({ userId: "u-3", role: "admin" }));
    expect(mockUpdateArgs).not.toHaveBeenCalled();
  });

  it("no-ops when the role is unchanged", async () => {
    mockMemberRole.mockResolvedValue({ data: { role: "member" } });
    await changeMemberRole(fd({ userId: "u-2", role: "member" }));
    expect(mockUpdateArgs).not.toHaveBeenCalled();
  });

  it("ignores an invalid role value", async () => {
    await changeMemberRole(fd({ userId: "u-2", role: "owner" }));
    expect(mockUpdateArgs).not.toHaveBeenCalled();
  });

  it("ignores an unknown member", async () => {
    mockMemberRole.mockResolvedValue({ data: null });
    await changeMemberRole(fd({ userId: "ghost", role: "admin" }));
    expect(mockUpdateArgs).not.toHaveBeenCalled();
  });
});

describe("removeMember", () => {
  it("removes a member", async () => {
    await removeMember(fd({ userId: "u-2" }));
    expect(mockDelete).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      { name: "membership.removed", props: { team_id: "org-1" } },
      { userId: "admin-1" }
    );
    expect(mockRevalidate).toHaveBeenCalledWith("/settings/team");
  });

  it("removes an admin when another admin remains", async () => {
    mockMemberRole.mockResolvedValue({ data: { role: "admin" } });
    mockAdminCount.mockResolvedValue({ count: 2 });
    await removeMember(fd({ userId: "u-2" }));
    expect(mockDelete).toHaveBeenCalled();
  });

  it("refuses to remove the last admin", async () => {
    mockMemberRole.mockResolvedValue({ data: { role: "admin" } });
    mockAdminCount.mockResolvedValue({ count: 1 });
    await removeMember(fd({ userId: "u-2" }));
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("does nothing for non-admins", async () => {
    mockGetAuthContext.mockResolvedValue({
      userId: "u-2",
      orgId: "org-1",
      canWrite: false,
    });
    await removeMember(fd({ userId: "u-3" }));
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("ignores an unknown member", async () => {
    mockMemberRole.mockResolvedValue({ data: null });
    await removeMember(fd({ userId: "ghost" }));
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
