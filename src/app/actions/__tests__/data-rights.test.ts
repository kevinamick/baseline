import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: referenced inside the hoisted vi.mock factories below.
const {
  mockGetUser,
  mockSignOut,
  mockDeleteUser,
  mockFrom,
  mockCookieDelete,
  mockRedirect,
  mockLog,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockSignOut: vi.fn(async () => ({ error: null })),
  mockDeleteUser: vi.fn(
    async (): Promise<{ error: { message: string } | null }> => ({ error: null })
  ),
  mockFrom: vi.fn(),
  mockCookieDelete: vi.fn(),
  mockRedirect: vi.fn(),
  mockLog: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser, signOut: mockSignOut },
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    auth: { admin: { deleteUser: mockDeleteUser } },
    from: mockFrom,
  },
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ delete: mockCookieDelete })),
}));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/auth/active-org", () => ({ ACTIVE_ORG_COOKIE: "active_org" }));
vi.mock("@/lib/logging/server", () => ({ log: mockLog }));

import { deleteAccount, exportAccountData } from "../data-rights";

// ---- A small chainable query mock over an in-memory `db`. ------------------
// supabaseAdmin.from(table) returns a thenable builder; the resolver inspects
// the recorded table/op/filters to answer each query the actions actually make.
let db: {
  usersRow: unknown;
  memberships: {
    org_id: string;
    user_id: string;
    role: string;
    created_at: string;
  }[];
  rubrics: unknown[];
};
const recorded: { promotions: unknown[]; orgDeletes: string[] } = {
  promotions: [],
  orgDeletes: [],
};

function resolve(ctx: {
  table: string;
  op: string;
  vals?: Record<string, unknown>;
  filters: [string, string, unknown][];
}) {
  const eq = (c: string) =>
    ctx.filters.find(([t, col]) => t === "eq" && col === c)?.[2];
  const hasEq = (c: string) => eq(c) !== undefined;
  const neq = (c: string) =>
    ctx.filters.find(([t, col]) => t === "neq" && col === c)?.[2];

  if (ctx.table === "users") return { data: db.usersRow, error: null };
  if (ctx.table === "rubrics") return { data: db.rubrics, error: null };

  if (ctx.table === "memberships") {
    if (ctx.op === "update") {
      recorded.promotions.push({ org_id: eq("org_id"), user_id: eq("user_id"), vals: ctx.vals });
      return { data: null, error: null };
    }
    if (hasEq("user_id") && hasEq("role")) {
      // settle: the orgs this user admins
      const rows = db.memberships
        .filter((m) => m.user_id === eq("user_id") && m.role === eq("role"))
        .map((m) => ({ org_id: m.org_id }));
      return { data: rows, error: null };
    }
    if (hasEq("org_id") && neq("user_id") !== undefined) {
      // settle: the org's other members, oldest first
      const rows = db.memberships
        .filter((m) => m.org_id === eq("org_id") && m.user_id !== neq("user_id"))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      return { data: rows, error: null };
    }
    if (hasEq("user_id")) {
      // export: all of the user's memberships
      return {
        data: db.memberships.filter((m) => m.user_id === eq("user_id")),
        error: null,
      };
    }
  }

  if (ctx.table === "organizations" && ctx.op === "delete") {
    recorded.orgDeletes.push(String(eq("id")));
    return { data: null, error: null };
  }

  throw new Error(`unexpected query: ${ctx.table}/${ctx.op}`);
}

function builder(table: string) {
  const ctx = {
    table,
    op: "select" as string,
    vals: undefined as Record<string, unknown> | undefined,
    filters: [] as [string, string, unknown][],
  };
  const chain = {
    select: () => chain,
    update: (vals: Record<string, unknown>) => {
      ctx.op = "update";
      ctx.vals = vals;
      return chain;
    },
    delete: () => {
      ctx.op = "delete";
      return chain;
    },
    eq: (col: string, val: unknown) => {
      ctx.filters.push(["eq", col, val]);
      return chain;
    },
    neq: (col: string, val: unknown) => {
      ctx.filters.push(["neq", col, val]);
      return chain;
    },
    order: () => chain,
    maybeSingle: () => Promise.resolve(resolve(ctx)),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolve(ctx)).then(res, rej),
  };
  return chain;
}

const USER = {
  id: "user-1",
  email: "Ada@Acme.com",
  created_at: "2026-01-01T00:00:00Z",
  last_sign_in_at: "2026-06-01T00:00:00Z",
  user_metadata: { name: "Ada" },
};

function fd(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  recorded.promotions = [];
  recorded.orgDeletes = [];
  db = {
    usersRow: { id: "user-1", created_at: "2026-01-01T00:00:00Z" },
    memberships: [{ org_id: "org-1", user_id: "user-1", role: "admin", created_at: "2026-01-01T00:00:00Z" }],
    rubrics: [{ id: "r1", created_by: "user-1", name: "Tone" }],
  };
  mockGetUser.mockResolvedValue({ data: { user: USER } });
  mockDeleteUser.mockResolvedValue({ error: null });
  mockFrom.mockImplementation(builder);
});

describe("exportAccountData", () => {
  it("returns the user's personal data as JSON with a filename", async () => {
    const result = await exportAccountData();
    expect(result.error).toBeUndefined();
    expect(result.filename).toBe("baseline-data-export-user-1.json");
    const parsed = JSON.parse(result.json!);
    expect(parsed.auth_profile).toMatchObject({ id: "user-1", email: "Ada@Acme.com" });
    expect(parsed.memberships).toHaveLength(1);
    expect(parsed.rubrics).toHaveLength(1);
    // Org-keyed billing is not personal data — never exported.
    expect(JSON.stringify(parsed)).not.toContain("stripe");
  });

  it("rejects when there is no session user", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const result = await exportAccountData();
    expect(result.error).toBeTruthy();
    expect(result.json).toBeUndefined();
  });

  it("returns a generic error when a query fails", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "rubrics") {
        return { select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) };
      }
      return builder(table);
    });
    const result = await exportAccountData();
    expect(result.error).toBe("Could not export your data. Please try again.");
    expect(mockLog.error).toHaveBeenCalled();
  });
});

describe("deleteAccount", () => {
  it("requires the typed email to match before deleting", async () => {
    const result = await deleteAccount({}, fd({ confirm: "wrong@acme.com" }));
    expect(result).toEqual({ error: "Type your email address exactly to confirm deletion." });
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it("matches the email case-insensitively, then deletes, signs out, clears the cookie and redirects", async () => {
    await deleteAccount({}, fd({ confirm: "  ada@acme.com  " }));
    expect(mockDeleteUser).toHaveBeenCalledWith("user-1");
    expect(mockSignOut).toHaveBeenCalled();
    expect(mockCookieDelete).toHaveBeenCalledWith("active_org");
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("deletes an org where the user is the only member", async () => {
    await deleteAccount({}, fd({ confirm: "ada@acme.com" }));
    expect(recorded.orgDeletes).toEqual(["org-1"]);
    expect(recorded.promotions).toHaveLength(0);
  });

  it("promotes the oldest remaining member when the user is the sole admin of a shared org", async () => {
    db.memberships = [
      { org_id: "org-1", user_id: "user-1", role: "admin", created_at: "2026-01-01T00:00:00Z" },
      { org_id: "org-1", user_id: "user-3", role: "member", created_at: "2026-03-01T00:00:00Z" },
      { org_id: "org-1", user_id: "user-2", role: "member", created_at: "2026-02-01T00:00:00Z" },
    ];
    await deleteAccount({}, fd({ confirm: "ada@acme.com" }));
    expect(recorded.orgDeletes).toHaveLength(0);
    expect(recorded.promotions).toEqual([
      { org_id: "org-1", user_id: "user-2", vals: { role: "admin" } },
    ]);
    expect(mockDeleteUser).toHaveBeenCalledWith("user-1");
  });

  it("leaves a shared org untouched when another admin remains", async () => {
    db.memberships = [
      { org_id: "org-1", user_id: "user-1", role: "admin", created_at: "2026-01-01T00:00:00Z" },
      { org_id: "org-1", user_id: "user-2", role: "admin", created_at: "2026-02-01T00:00:00Z" },
    ];
    await deleteAccount({}, fd({ confirm: "ada@acme.com" }));
    expect(recorded.orgDeletes).toHaveLength(0);
    expect(recorded.promotions).toHaveLength(0);
    expect(mockDeleteUser).toHaveBeenCalledWith("user-1");
  });

  it("returns an error and does not clear the session when the delete fails", async () => {
    mockDeleteUser.mockResolvedValueOnce({ error: { message: "nope" } });
    const result = await deleteAccount({}, fd({ confirm: "ada@acme.com" }));
    expect(result).toEqual({ error: "Could not delete your account. Please try again." });
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockCookieDelete).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
