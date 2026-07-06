import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("server-only", () => ({}));

interface MockBuilder {
  _result: unknown;
  from: Mock;
  select: Mock;
  eq: Mock;
  is: Mock;
  order: Mock;
  limit: Mock;
  maybeSingle: Mock;
  then: (resolve: (v: unknown) => void) => void;
}

const builder: MockBuilder = {
  _result: { data: null, error: null },
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  is: vi.fn(),
  order: vi.fn(),
  limit: vi.fn(),
  maybeSingle: vi.fn(),
  then: (resolve: (v: unknown) => void) => resolve(builder._result),
};

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: builder }));

const ORG_ID = "org_abc";
const EVAL_RUN_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  for (const method of ["from", "select", "eq", "is", "order", "limit"] as const) {
    builder[method].mockReturnValue(builder);
  }
  builder._result = { data: null, error: null };
  builder.maybeSingle.mockResolvedValue({ data: { id: EVAL_RUN_ID }, error: null });
});

describe("resolveEvalRunInstances", () => {
  it("maps rows ordered by row_index into the Instance shape, dropping agent_output", async () => {
    builder._result = {
      data: [
        { user_input: "Q1", agent_output: "should never be copied", expected_output: "A1", retrieval_context: null },
        { user_input: "Q2", agent_output: "also dropped", expected_output: null, retrieval_context: "ctx" },
      ],
      error: null,
    };
    const { resolveEvalRunInstances } = await import("./eval-run-instances");
    const result = await resolveEvalRunInstances(ORG_ID, EVAL_RUN_ID);

    expect(result).toEqual({
      instances: [
        { userInput: "Q1", expectedOutput: "A1", retrievalContext: null },
        { userInput: "Q2", expectedOutput: null, retrievalContext: "ctx" },
      ],
    });
    // Never selects agent_output.
    expect(builder.select).toHaveBeenCalledWith("user_input, expected_output, retrieval_context");
    expect(builder.order).toHaveBeenCalledWith("row_index", { ascending: true });
  });

  it("org-scopes the eval run lookup through its rubric (class-B, no own org_id)", async () => {
    builder._result = { data: [{ user_input: "Q1", expected_output: null, retrieval_context: null }], error: null };
    const { resolveEvalRunInstances } = await import("./eval-run-instances");
    await resolveEvalRunInstances(ORG_ID, EVAL_RUN_ID);

    expect(builder.eq).toHaveBeenCalledWith("rubrics.org_id", ORG_ID);
    expect(builder.eq).toHaveBeenCalledWith("id", EVAL_RUN_ID);
  });

  it("caps the returned rows at MAX_OPTIMIZATION_INSTANCES", async () => {
    const { MAX_OPTIMIZATION_INSTANCES } = await import("@/lib/validation/schemas");
    builder._result = { data: [{ user_input: "Q", expected_output: null, retrieval_context: null }], error: null };
    const { resolveEvalRunInstances } = await import("./eval-run-instances");
    await resolveEvalRunInstances(ORG_ID, EVAL_RUN_ID);

    expect(builder.limit).toHaveBeenCalledWith(MAX_OPTIMIZATION_INSTANCES);
  });

  it("refuses cleanly when the eval run isn't found (foreign or unknown id)", async () => {
    builder.maybeSingle.mockResolvedValue({ data: null, error: null });
    const { resolveEvalRunInstances } = await import("./eval-run-instances");
    const result = await resolveEvalRunInstances(ORG_ID, EVAL_RUN_ID);
    expect(result).toEqual({ error: "not_found" });
  });

  it("refuses cleanly with 'empty' when the eval run has no rows", async () => {
    builder._result = { data: [], error: null };
    const { resolveEvalRunInstances } = await import("./eval-run-instances");
    const result = await resolveEvalRunInstances(ORG_ID, EVAL_RUN_ID);
    expect(result).toEqual({ error: "empty" });
  });

  it("excludes a soft-deleted eval run", async () => {
    builder._result = { data: [{ user_input: "Q", expected_output: null, retrieval_context: null }], error: null };
    const { resolveEvalRunInstances } = await import("./eval-run-instances");
    await resolveEvalRunInstances(ORG_ID, EVAL_RUN_ID);
    expect(builder.is).toHaveBeenCalledWith("deleted_at", null);
  });
});
