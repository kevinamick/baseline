import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// The logging module has `import "server-only"`, which throws outside a server bundle.
vi.mock("server-only", () => ({}));

interface MockBuilder {
  _result: unknown;
  // When set, an awaited chain resolves to the seeded rows that match every
  // recorded `.eq` filter (dotted keys resolved against an embedded parent
  // shape) — used to prove org-scoping behaviorally (#255). When null, the
  // builder falls back to `_result` (the default for every other test).
  _scopedRows: Array<Record<string, unknown>> | null;
  _filters: Array<[string, unknown]>;
  then: (resolve: (v: unknown) => void) => void;
  from: Mock;
  select: Mock;
  insert: Mock;
  update: Mock;
  delete: Mock;
  eq: Mock;
  in: Mock;
  order: Mock;
  single: Mock;
  maybeSingle: Mock;
  rpc: Mock;
}

function resolvePath(row: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object") {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, row);
}

// --- Mocks ---

const mockRedirect = vi.fn();
const mockRevalidatePath = vi.fn();
const mockGetAuthContext = vi.fn();

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/analytics/server", () => ({ track: vi.fn() }));

// Chainable Supabase builder mock.
// Chainable methods return `this` so calls can be chained arbitrarily.
// Terminal methods resolve to configurable values.
// The builder is also thenable so chains ending in a raw `.eq()` can be awaited.
const builder: MockBuilder = {
  _result: { data: null, error: null },
  _scopedRows: null,
  _filters: [],
  from: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  eq: vi.fn((col: string, val: unknown) => {
    builder._filters.push([col, val]);
    return builder;
  }),
  in: vi.fn(),
  order: vi.fn(),
  single: vi.fn(),
  maybeSingle: vi.fn(),
  rpc: vi.fn(),
  // Makes builder awaitable for chains that don't end in single()/maybeSingle().
  // With seeded rows, filters by every recorded `.eq` (org-scoping fidelity).
  then: (resolve: (v: unknown) => void) => {
    if (builder._scopedRows !== null) {
      const matched = builder._scopedRows.filter((row) =>
        builder._filters.every(([col, val]) => resolvePath(row, col) === val)
      );
      resolve({ data: matched, error: null });
      return;
    }
    resolve(builder._result);
  },
};

for (const method of ["from", "select", "insert", "update", "delete", "in", "order"] as const) {
  builder[method].mockReturnValue(builder);
}

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: builder,
}));

// --- Helpers ---

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

const validCriteria = JSON.stringify([
  { name: "Accuracy", weight: 0.6, steps: ["Check factual correctness"] },
  { name: "Clarity", weight: 0.4, steps: ["Check readability"] },
]);

const validFields = {
  name: "Test Rubric",
  scenario_description: "A support conversation",
  expected_outcome: "Helpful, accurate response",
  evaluation_mode: "prompt_response",
  grounding_context: "",
  criteria: validCriteria,
};

// --- Setup ---

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue({ userId: "user_abc", orgId: "org_abc", role: "admin", canWrite: true });
  builder._result = { data: null, error: null };
  builder._scopedRows = null;
  builder._filters = [];
  builder.single.mockResolvedValue({ data: { id: "rubric_1" }, error: null });
  builder.maybeSingle.mockResolvedValue({ data: null, error: null });
  // redirect throws in Next.js (caught internally), simulate that behaviour
  mockRedirect.mockImplementation(() => { throw new Error("NEXT_REDIRECT"); });
});

// --- getRubric ---

describe("getRubric", () => {
  it("returns null when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
    const { getRubric } = await import("../rubrics");
    const result = await getRubric("rubric_1");
    expect(result).toBeNull();
  });

  it("queries by id and org_id, returns data", async () => {
    const fakeRubric = { id: "rubric_1", name: "My Rubric" };
    builder.maybeSingle.mockResolvedValue({ data: fakeRubric, error: null });
    const { getRubric } = await import("../rubrics");
    const result = await getRubric("rubric_1");
    expect(result).toEqual(fakeRubric);
    expect(builder.eq).toHaveBeenCalledWith("id", "rubric_1");
    expect(builder.eq).toHaveBeenCalledWith("org_id", "org_abc");
  });
});

// --- createRubric ---

describe("createRubric", () => {
  it("returns error when criteria JSON is invalid", async () => {
    const { createRubric } = await import("../rubrics");
    const fd = makeFormData({ ...validFields, criteria: "not json" });
    const result = await createRubric({}, fd);
    expect(result.errors?.criteria).toBeDefined();
  });

  it("returns validation error when weights don't sum to 1.0", async () => {
    const badCriteria = JSON.stringify([
      { name: "Accuracy", weight: 0.3, steps: ["Step 1"] },
      { name: "Clarity", weight: 0.3, steps: ["Step 2"] },
    ]);
    const { createRubric } = await import("../rubrics");
    const result = await createRubric({}, makeFormData({ ...validFields, criteria: badCriteria }));
    expect(result.errors?.criteria).toBeDefined();
  });

  it("returns validation error when a required field is missing", async () => {
    const { createRubric } = await import("../rubrics");
    const withoutName = Object.fromEntries(Object.entries(validFields).filter(([k]) => k !== "name"));
    const result = await createRubric({}, makeFormData(withoutName as Record<string, string>));
    expect(result.errors?.name).toBeDefined();
  });

  it("returns message on DB insert failure", async () => {
    builder.single.mockResolvedValue({ data: null, error: { message: "db error" } });
    const { createRubric } = await import("../rubrics");
    const result = await createRubric({}, makeFormData(validFields));
    expect(result.message).toMatch(/failed/i);
  });

  it("revalidates and returns success with the new rubric id", async () => {
    const { createRubric } = await import("../rubrics");
    const result = await createRubric({}, makeFormData(validFields));
    // The id lets the caller auto-select the new rubric so Run Eval renders (#330).
    expect(result).toEqual({ success: true, rubricId: "rubric_1" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/rubrics");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("inserts with created_by and org_id set correctly", async () => {
    const { createRubric } = await import("../rubrics");
    const result = await createRubric({}, makeFormData(validFields));
    expect(result).toEqual({ success: true, rubricId: "rubric_1" });
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ created_by: "user_abc", org_id: "org_abc" })
    );
  });
});

// --- updateRubric ---

describe("updateRubric", () => {
  it("returns error when id is missing", async () => {
    const { updateRubric } = await import("../rubrics");
    const result = await updateRubric({}, makeFormData(validFields));
    expect(result.message).toMatch(/missing rubric id/i);
  });

  it("returns message on DB update failure", async () => {
    builder._result = { error: { message: "db error" } };
    const { updateRubric } = await import("../rubrics");
    const result = await updateRubric({}, makeFormData({ ...validFields, id: "rubric_1" }));
    expect(result.message).toMatch(/failed/i);
  });

  it("enforces ownership via org_id filter", async () => {
    const { updateRubric } = await import("../rubrics");
    const result = await updateRubric({}, makeFormData({ ...validFields, id: "rubric_1" }));
    expect(result).toEqual({ success: true });
    expect(builder.eq).toHaveBeenCalledWith("org_id", "org_abc");
  });

  it("revalidates and returns success", async () => {
    const { updateRubric } = await import("../rubrics");
    const result = await updateRubric({}, makeFormData({ ...validFields, id: "rubric_1" }));
    expect(result).toEqual({ success: true });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/rubrics");
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// --- deleteRubric ---

describe("deleteRubric", () => {
  it("throws when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, role: "member", canWrite: false });
    const { deleteRubric } = await import("../rubrics");
    await expect(deleteRubric("rubric_1")).rejects.toThrow("Not authenticated");
  });

  it("throws with a 'verify in-flight' message when the eval_runs pre-delete lookup fails", async () => {
    // A DB error on the in-flight eval_runs query must ABORT the delete — proceeding would
    // cascade-delete runs whose billing reservations can't be settled first (#180).
    builder._result = { error: { message: "db error" } };
    const { deleteRubric } = await import("../rubrics");
    await expect(deleteRubric("rubric_1")).rejects.toThrow(
      "Failed to delete rubric — couldn't verify in-flight runs. Please try again."
    );
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("deletes with org_id ownership filter and redirects", async () => {
    const { deleteRubric } = await import("../rubrics");
    await expect(deleteRubric("rubric_1")).rejects.toThrow("NEXT_REDIRECT");
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("id", "rubric_1");
    expect(builder.eq).toHaveBeenCalledWith("org_id", "org_abc");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/rubrics");
  });

  it("releases in-flight runs' point reservations before the cascade delete", async () => {
    // The cascade nulls the ledger's run FK, so reservations must settle first (#180).
    builder._result = { data: [{ id: "run_9" }], error: null };
    builder.rpc.mockResolvedValue({ error: null });
    const { deleteRubric } = await import("../rubrics");
    await expect(deleteRubric("rubric_1")).rejects.toThrow("NEXT_REDIRECT");
    expect(builder.in).toHaveBeenCalledWith("status", ["queued", "running"]);
    expect(builder.rpc).toHaveBeenCalledWith("settle_eval_run_points", {
      p_run_id: "run_9",
      p_outcome: "skipped",
    });
  });

  it("fires NO settle RPCs when deleting another org's rubric id (#255 regression)", async () => {
    // The in-flight reads are now org-scoped (eval_runs via parentScoped's
    // rubrics.org_id !inner embed; optimization_runs via tenantDb's org_id).
    // Seed in-flight runs that belong to ORG B; the caller's ctx is ORG abc, so
    // both org-scoped reads return nothing and no tenant's settles are triggered.
    builder._scopedRows = [
      // an eval_run whose embedded rubric is org B's (cross-tenant)
      { id: "run_b", rubric_id: "rub_b", status: "running", rubrics: { org_id: "org_OTHER" } },
      // an optimization_run owned by org B (own org_id, cross-tenant)
      { id: "opt_b", rubric_id: "rub_b", status: "running", org_id: "org_OTHER" },
    ];
    builder.rpc.mockResolvedValue({ error: null });

    const { deleteRubric } = await import("../rubrics");
    await expect(deleteRubric("rub_b")).rejects.toThrow("NEXT_REDIRECT");

    // No settle RPCs — neither org B's eval-run nor its optimization-run was
    // visible to org abc's scoped reads, so nothing settled.
    expect(builder.rpc).not.toHaveBeenCalled();
    // The org filter genuinely reached both reads.
    expect(builder.eq).toHaveBeenCalledWith("rubrics.org_id", "org_abc");
    expect(builder.eq).toHaveBeenCalledWith("org_id", "org_abc");
  });
});
