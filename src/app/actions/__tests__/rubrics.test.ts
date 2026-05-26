import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

interface MockBuilder {
  _result: unknown;
  then: (resolve: (v: unknown) => void) => void;
  from: Mock;
  select: Mock;
  insert: Mock;
  update: Mock;
  delete: Mock;
  eq: Mock;
  order: Mock;
  single: Mock;
  maybeSingle: Mock;
}

// --- Mocks ---

const mockRedirect = vi.fn();
const mockRevalidatePath = vi.fn();
const mockAuth = vi.fn();

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));

// Chainable Supabase builder mock.
// Chainable methods return `this` so calls can be chained arbitrarily.
// Terminal methods resolve to configurable values.
// The builder is also thenable so chains ending in a raw `.eq()` can be awaited.
const builder: MockBuilder = {
  _result: { data: null, error: null },
  from: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  eq: vi.fn(),
  order: vi.fn(),
  single: vi.fn(),
  maybeSingle: vi.fn(),
  // Makes builder awaitable for chains that don't end in single()/maybeSingle()
  then: (resolve: (v: unknown) => void) => resolve(builder._result),
};

for (const method of ["from", "select", "insert", "update", "delete", "eq", "order"] as const) {
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
  mockAuth.mockResolvedValue({ userId: "user_abc" });
  builder._result = { data: null, error: null };
  builder.single.mockResolvedValue({ data: { id: "rubric_1" }, error: null });
  builder.maybeSingle.mockResolvedValue({ data: null, error: null });
  // redirect throws in Next.js (caught internally), simulate that behaviour
  mockRedirect.mockImplementation(() => { throw new Error("NEXT_REDIRECT"); });
});

// --- getRubric ---

describe("getRubric", () => {
  it("returns null when unauthenticated", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const { getRubric } = await import("../rubrics");
    const result = await getRubric("rubric_1");
    expect(result).toBeNull();
  });

  it("queries by id and created_by, returns data", async () => {
    const fakeRubric = { id: "rubric_1", name: "My Rubric" };
    builder.maybeSingle.mockResolvedValue({ data: fakeRubric, error: null });
    const { getRubric } = await import("../rubrics");
    const result = await getRubric("rubric_1");
    expect(result).toEqual(fakeRubric);
    expect(builder.eq).toHaveBeenCalledWith("id", "rubric_1");
    expect(builder.eq).toHaveBeenCalledWith("created_by", "user_abc");
  });
});

// --- createRubric ---

describe("createRubric", () => {
  it("throws when unauthenticated", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const { createRubric } = await import("../rubrics");
    await expect(createRubric({}, makeFormData(validFields))).rejects.toThrow("Not authenticated");
  });

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
    const { name: _name, ...withoutName } = validFields;
    const result = await createRubric({}, makeFormData(withoutName as Record<string, string>));
    expect(result.errors?.name).toBeDefined();
  });

  it("returns message on DB insert failure", async () => {
    builder.single.mockResolvedValue({ data: null, error: { message: "db error" } });
    const { createRubric } = await import("../rubrics");
    const result = await createRubric({}, makeFormData(validFields));
    expect(result.message).toMatch(/failed/i);
  });

  it("revalidates and redirects on success", async () => {
    const { createRubric } = await import("../rubrics");
    await expect(createRubric({}, makeFormData(validFields))).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/rubrics");
    expect(mockRedirect).toHaveBeenCalledWith("/rubrics");
  });

  it("inserts with created_by set to the authenticated user", async () => {
    const { createRubric } = await import("../rubrics");
    await expect(createRubric({}, makeFormData(validFields))).rejects.toThrow("NEXT_REDIRECT");
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ created_by: "user_abc" })
    );
  });
});

// --- updateRubric ---

describe("updateRubric", () => {
  it("throws when unauthenticated", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const { updateRubric } = await import("../rubrics");
    await expect(updateRubric({}, makeFormData({ ...validFields, id: "rubric_1" }))).rejects.toThrow("Not authenticated");
  });

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

  it("enforces ownership via created_by filter", async () => {
    const { updateRubric } = await import("../rubrics");
    await expect(updateRubric({}, makeFormData({ ...validFields, id: "rubric_1" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(builder.eq).toHaveBeenCalledWith("created_by", "user_abc");
  });

  it("revalidates and redirects on success", async () => {
    const { updateRubric } = await import("../rubrics");
    await expect(updateRubric({}, makeFormData({ ...validFields, id: "rubric_1" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/rubrics");
    expect(mockRedirect).toHaveBeenCalledWith("/rubrics");
  });
});

// --- deleteRubric ---

describe("deleteRubric", () => {
  it("throws when unauthenticated", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const { deleteRubric } = await import("../rubrics");
    await expect(deleteRubric("rubric_1")).rejects.toThrow("Not authenticated");
  });

  it("deletes with ownership filter and redirects", async () => {
    const { deleteRubric } = await import("../rubrics");
    await expect(deleteRubric("rubric_1")).rejects.toThrow("NEXT_REDIRECT");
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("id", "rubric_1");
    expect(builder.eq).toHaveBeenCalledWith("created_by", "user_abc");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/rubrics");
  });
});
