import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// `import "server-only"` throws outside a server bundle.
vi.mock("server-only", () => ({}));

// A recording fake of the Supabase query builder. It is a single chainable
// object (every chain method returns `this`) that also doubles as a tiny
// in-memory store: `select()` filters the seeded rows by the recorded `.eq`
// filters when awaited, and `insert()` records the row that would be written.
// This lets us prove the org_id enforcement *behaviorally* — a query scoped to
// org A genuinely cannot see org B's seeded row, and an insert genuinely lands
// under ctx's org — rather than just asserting a method was called.
interface RecordingBuilder {
  rows: Array<Record<string, unknown>>;
  filters: Array<[string, unknown]>;
  inserted: Record<string, unknown> | null;
  from: Mock;
  select: Mock;
  insert: Mock;
  update: Mock;
  delete: Mock;
  eq: Mock;
  maybeSingle: Mock;
  then: (resolve: (v: unknown) => void) => void;
}

const builder: RecordingBuilder = {
  rows: [],
  filters: [],
  inserted: null,
  from: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  eq: vi.fn((col: string, val: unknown) => {
    builder.filters.push([col, val]);
    return builder;
  }),
  maybeSingle: vi.fn(),
  // Awaiting a select chain returns the seeded rows that match every recorded
  // filter — exactly what a real org_id-scoped query would return.
  then: (resolve: (v: unknown) => void) => {
    const matched = builder.rows.filter((row) =>
      builder.filters.every(([col, val]) => row[col] === val)
    );
    resolve({ data: matched, error: null });
  },
};

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: builder }));

const ORG_A = "org_aaaaaaaa";
const ORG_B = "org_bbbbbbbb";

function ctxFor(orgId: string | null) {
  return {
    userId: "user_1",
    email: "u@example.com",
    orgId,
    role: "admin" as const,
    canWrite: true,
  };
}

let tenantDb: typeof import("../tenant-db").tenantDb;

beforeEach(async () => {
  ({ tenantDb } = await import("../tenant-db"));
  vi.clearAllMocks();
  for (const m of ["from", "select", "insert", "update", "delete"] as const) {
    builder[m].mockReturnValue(builder);
  }
  builder.eq.mockImplementation((col: string, val: unknown) => {
    builder.filters.push([col, val]);
    return builder;
  });
  builder.maybeSingle.mockImplementation(() => {
    const matched = builder.rows.filter((row) =>
      builder.filters.every(([col, val]) => row[col] === val)
    );
    return Promise.resolve({ data: matched[0] ?? null, error: null });
  });
  builder.rows = [];
  builder.filters = [];
  builder.inserted = null;
});

describe("tenantDb", () => {
  it("throws if the AuthContext has no resolved org", () => {
    expect(() => tenantDb(ctxFor(null))).toThrow(/resolved orgId/);
  });

  // --- Acceptance criterion #3a: a read can't return another org's rows ---

  it("a select scoped to org A cannot return org B's row", async () => {
    // Two rubrics seeded, one per org. A real leak would surface org B's row.
    builder.rows = [
      { id: "rub_a", org_id: ORG_A, name: "A's rubric" },
      { id: "rub_b", org_id: ORG_B, name: "B's rubric" },
    ];

    const { data } = await tenantDb(ctxFor(ORG_A)).from("rubrics").select();

    expect(data).toEqual([{ id: "rub_a", org_id: ORG_A, name: "A's rubric" }]);
    // The org filter is always applied, even when the call site never wrote it.
    expect(builder.filters).toContainEqual(["org_id", ORG_A]);
  });

  it("a by-id read for a row owned by another org returns nothing", async () => {
    builder.rows = [{ id: "rub_b", org_id: ORG_B, name: "B's rubric" }];

    // Org A asks for B's row by its real id — the org filter still excludes it.
    const { data } = await tenantDb(ctxFor(ORG_A))
      .from("rubrics")
      .select()
      .eq("id", "rub_b")
      .maybeSingle();

    expect(data).toBeNull();
  });

  // --- Acceptance criterion #3b: an insert can't land under another org's id ---

  it("stamps ctx.orgId on insert and ignores a caller-supplied org_id", () => {
    builder.insert.mockImplementation((row: Record<string, unknown>) => {
      builder.inserted = row;
      return builder;
    });

    // The caller tries to smuggle in org B's id; the helper must overwrite it.
    tenantDb(ctxFor(ORG_A))
      .from("rubrics")
      .insert({ name: "x", created_by: "user_1", org_id: ORG_B });

    expect(builder.inserted).toMatchObject({ name: "x", org_id: ORG_A });
    expect(builder.inserted?.org_id).toBe(ORG_A);
  });

  // --- Writes constrain by org_id ---

  it("constrains update by ctx.orgId and strips a caller-supplied org_id", () => {
    let updatePayload: Record<string, unknown> | null = null;
    builder.update.mockImplementation((row: Record<string, unknown>) => {
      updatePayload = row;
      return builder;
    });

    tenantDb(ctxFor(ORG_A))
      .from("rubrics")
      .update({ name: "renamed", org_id: ORG_B })
      .eq("id", "rub_a");

    expect(updatePayload).toEqual({ name: "renamed" });
    expect(builder.filters).toContainEqual(["org_id", ORG_A]);
  });

  it("constrains delete by ctx.orgId", () => {
    tenantDb(ctxFor(ORG_A)).from("rubrics").delete().eq("id", "rub_a");

    expect(builder.delete).toHaveBeenCalled();
    expect(builder.filters).toContainEqual(["org_id", ORG_A]);
  });
});
