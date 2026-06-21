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
  selects: string[];
  inserted: Record<string, unknown> | null;
  from: Mock;
  select: Mock;
  insert: Mock;
  update: Mock;
  delete: Mock;
  eq: Mock;
  in: Mock;
  maybeSingle: Mock;
  then: (resolve: (v: unknown) => void) => void;
}

// Resolve a dotted filter key (`eval_runs.rubrics.org_id`) against a seeded row
// that carries the embedded parent shape PostgREST would return, e.g.
// `{ id, eval_runs: { rubrics: { org_id } } }`. A flat key (`org_id`, `id`)
// reads the top-level field. This is what lets a class-B test prove the embed
// filter behaviorally rather than only asserting the constructed strings.
function resolvePath(row: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object") {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, row);
}

const builder: RecordingBuilder = {
  rows: [],
  filters: [],
  selects: [],
  inserted: null,
  from: vi.fn(),
  select: vi.fn((cols: string) => {
    builder.selects.push(cols);
    return builder;
  }),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  eq: vi.fn((col: string, val: unknown) => {
    builder.filters.push([col, val]);
    return builder;
  }),
  in: vi.fn(() => builder),
  maybeSingle: vi.fn(),
  // Awaiting a select chain returns the seeded rows that match every recorded
  // filter — exactly what a real org_id-scoped query would return. Filter keys
  // may be dotted (the class-B embed path), resolved against the row's embedded
  // parent shape.
  then: (resolve: (v: unknown) => void) => {
    const matched = builder.rows.filter((row) =>
      builder.filters.every(([col, val]) => resolvePath(row, col) === val)
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
let parentScoped: typeof import("../tenant-db").parentScoped;
let CLASS_B_PARENT_SCOPE: typeof import("../tenant-db").CLASS_B_PARENT_SCOPE;

beforeEach(async () => {
  ({ tenantDb, parentScoped, CLASS_B_PARENT_SCOPE } = await import("../tenant-db"));
  vi.clearAllMocks();
  for (const m of ["from", "insert", "update", "delete", "in"] as const) {
    builder[m].mockReturnValue(builder);
  }
  builder.select.mockImplementation((cols: string) => {
    builder.selects.push(cols);
    return builder;
  });
  builder.eq.mockImplementation((col: string, val: unknown) => {
    builder.filters.push([col, val]);
    return builder;
  });
  builder.maybeSingle.mockImplementation(() => {
    const matched = builder.rows.filter((row) =>
      builder.filters.every(([col, val]) => resolvePath(row, col) === val)
    );
    return Promise.resolve({ data: matched[0] ?? null, error: null });
  });
  builder.rows = [];
  builder.filters = [];
  builder.selects = [];
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

    // `org_id` is now a COMPILE error on the payload (Omit<Insert,"org_id">); cast past
    // it to prove the RUNTIME strip is still there as defense-in-depth even if a caller
    // force-casts one in.
    tenantDb(ctxFor(ORG_A))
      .from("rubrics")
      .insert({ name: "x", created_by: "user_1", org_id: ORG_B } as never);

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

    // org_id is compile-forbidden on the patch too; cast past it to test the runtime strip.
    tenantDb(ctxFor(ORG_A))
      .from("rubrics")
      .update({ name: "renamed", org_id: ORG_B } as never)
      .eq("id", "rub_a");

    expect(updatePayload).toEqual({ name: "renamed" });
    expect(builder.filters).toContainEqual(["org_id", ORG_A]);
  });

  it("constrains delete by ctx.orgId", () => {
    tenantDb(ctxFor(ORG_A)).from("rubrics").delete().eq("id", "rub_a");

    expect(builder.delete).toHaveBeenCalled();
    expect(builder.filters).toContainEqual(["org_id", ORG_A]);
  });

  // --- Typed column projection (a) ---

  it("projects the requested columns (typed) instead of *", async () => {
    builder.rows = [{ id: "rub_a", name: "A's rubric", org_id: ORG_A }];

    // Typed key varargs → joined into the postgrest projection string (the fake builder
    // doesn't itself project, so the projection is asserted via `selects`; the result TYPE
    // is asserted by the compile-time checks below).
    const { data } = await tenantDb(ctxFor(ORG_A)).from("rubrics").select("id", "name");

    expect(builder.selects).toContain("id, name");
    expect(data?.[0]?.id).toBe("rub_a");
    if (data) {
      const first = data[0];
      void first.id;
      void first.name;
      // An UNSELECTED column is a compile error — proves the projection narrows the type.
      // @ts-expect-error scenario_description was not selected
      void first.scenario_description;
    }
  });

  it("rejects an unknown column name at compile time", async () => {
    // @ts-expect-error "nope" is not a column of rubrics
    await tenantDb(ctxFor(ORG_A)).from("rubrics").select("nope");
  });

  it("defaults to * when no columns are given (behavior-preserving)", async () => {
    builder.rows = [{ id: "rub_a", org_id: ORG_A }];
    await tenantDb(ctxFor(ORG_A)).from("rubrics").select();
    expect(builder.selects).toContain("*");
  });
});

describe("parentScoped", () => {
  it("throws if the AuthContext has no resolved org", () => {
    expect(() => parentScoped(ctxFor(null))).toThrow(/resolved orgId/);
  });

  // --- (b) embed-filter construction: 1-hop ---

  it("builds a 1-hop !inner embed + org filter on the embedded column", async () => {
    await parentScoped(ctxFor(ORG_A)).from("eval_runs").select("id");

    // Projection carries the parent embed; filter targets the embedded org_id.
    expect(builder.selects).toContain("id, rubrics!inner(org_id)");
    expect(builder.filters).toContainEqual(["rubrics.org_id", ORG_A]);
  });

  // --- (b) embed-filter construction: 2-hop ---

  it("builds a 2-hop nested !inner embed + dotted filter key", async () => {
    await parentScoped(ctxFor(ORG_A)).from("eval_run_rows").select("id");

    expect(builder.selects).toContain(
      "id, eval_runs!inner(rubrics!inner(org_id))"
    );
    expect(builder.filters).toContainEqual([
      "eval_runs.rubrics.org_id",
      ORG_A,
    ]);
  });

  it("defaults the projection to * and still appends the embed", async () => {
    await parentScoped(ctxFor(ORG_A)).from("schedule_inputs").select();
    expect(builder.selects).toContain("*, schedules!inner(org_id)");
  });

  // --- (b) behavioral isolation: org A can't see org B's child rows ---

  it("a class-B select scoped to org A cannot see org B's child rows", async () => {
    // Two eval_runs, each carrying its embedded rubric's org_id (the shape
    // PostgREST returns under `rubrics!inner(org_id)`). A leak would surface B's.
    builder.rows = [
      { id: "run_a", rubrics: { org_id: ORG_A } },
      { id: "run_b", rubrics: { org_id: ORG_B } },
    ];

    const { data } = await parentScoped(ctxFor(ORG_A))
      .from("eval_runs")
      .select("id");

    expect(data).toEqual([{ id: "run_a", rubrics: { org_id: ORG_A } }]);
  });

  it("a by-rubric_id class-B read for another org's child returns nothing", async () => {
    // Org A passes org B's rubric_id; the !inner org filter still excludes it.
    builder.rows = [
      { id: "run_b", rubric_id: "rub_b", rubrics: { org_id: ORG_B } },
    ];

    const { data } = await parentScoped(ctxFor(ORG_A))
      .from("eval_runs")
      .select("id")
      .eq("rubric_id", "rub_b")
      .in("status", ["queued", "running"]);

    expect(data).toEqual([]);
  });

  it("exposes no write methods on the class-B path (reads only)", () => {
    const b = parentScoped(ctxFor(ORG_A)).from("eval_runs") as Record<
      string,
      unknown
    >;
    expect(typeof b.select).toBe("function");
    expect(b.insert).toBeUndefined();
    expect(b.update).toBeUndefined();
    expect(b.delete).toBeUndefined();
  });

  it("CLASS_B_PARENT_SCOPE embed/filterKey stay in sync per table", () => {
    // The filterKey must be the embed's chain of parent RESOURCE names + `.org_id`,
    // so a typo can't silently produce an unscoped (leaking) query. A parent segment
    // may carry an FK disambiguator (`optimization_runs!opt_run_id`); the filter key
    // uses the resource name only (the part before `!`), so strip the hint here too.
    for (const { embed, filterKey } of Object.values(CLASS_B_PARENT_SCOPE)) {
      const parents = embed
        .replace(/\(org_id\)/g, "")
        .split("!inner")
        .map((p) => p.replace(/[(),\s]/g, ""))
        .map((p) => p.split("!")[0]) // drop any `!<fk-hint>` → resource name only
        .filter(Boolean);
      expect(filterKey).toBe(`${parents.join(".")}.org_id`);
    }
  });
});
