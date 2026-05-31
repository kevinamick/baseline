import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

interface MockBuilder {
  _result: unknown;
  from: Mock;
  select: Mock;
  insert: Mock;
  update: Mock;
  delete: Mock;
  eq: Mock;
  order: Mock;
  limit: Mock;
  single: Mock;
  maybeSingle: Mock;
  rpc: Mock;
  then: (resolve: (v: unknown) => void) => void;
}

// --- Mocks ---

const mockAuth = vi.fn();
const mockTrack = vi.fn();
const mockInsertConnection = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({ auth: mockAuth }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/connections/create", () => ({ insertConnection: mockInsertConnection }));

const builder: MockBuilder = {
  _result: { data: null, error: null },
  from: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  eq: vi.fn(),
  order: vi.fn(),
  limit: vi.fn(),
  single: vi.fn(),
  maybeSingle: vi.fn(),
  rpc: vi.fn(),
  then: (resolve: (v: unknown) => void) => resolve(builder._result),
};

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: builder }));

// --- Fixtures ---

const RUBRIC_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Nightly support eval",
    description: null,
    rubricId: RUBRIC_ID,
    evalType: "tabular" as const,
    connectionId: null,
    newConnection: {
      name: "Support agent",
      endpoint: "https://api.example.com/agent",
      authHeader: null,
      authValue: null,
      requestTemplate: '{"input":"{{user_input}}"}',
      responsePath: "output",
    },
    inputs: [{ userInput: "How do I reset my password?", expectedOutput: null, retrievalContext: null }],
    cadence: {
      frequency: "daily" as const,
      localHour: 9,
      daysOfWeek: undefined,
      dayOfMonth: null,
      timezone: "America/New_York",
    },
    enabled: true,
    notificationEmails: [],
    ...overrides,
  };
}

// --- Setup ---

beforeEach(() => {
  vi.clearAllMocks();
  // Re-establish the chainable builder each test: vitest.config has mockReset:true,
  // which wipes mock return values before every test.
  for (const method of ["from", "select", "insert", "update", "delete", "eq", "order", "limit"] as const) {
    builder[method].mockReturnValue(builder);
  }
  mockAuth.mockResolvedValue({ userId: "user_abc", orgId: "org_abc", orgRole: "org:admin" });
  builder._result = { data: null, error: null };
  builder.maybeSingle.mockResolvedValue({ data: { id: "rubric_1" }, error: null });
  builder.single.mockResolvedValue({ data: { id: "sched_1" }, error: null });
  builder.rpc.mockResolvedValue({ data: "2026-06-01T13:00:00.000Z", error: null });
  mockInsertConnection.mockResolvedValue({ connectionId: "conn_1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// --- createSchedule ---

describe("createSchedule", () => {
  it("returns error when unauthenticated", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const { createSchedule } = await import("../schedules");
    expect(await createSchedule(validInput())).toEqual({ error: "Not authenticated" });
  });

  it("rejects non-contributors", async () => {
    mockAuth.mockResolvedValue({ userId: "u", orgId: "o", orgRole: "org:member" });
    const { createSchedule } = await import("../schedules");
    expect(await createSchedule(validInput())).toEqual({
      error: "Only contributors can create schedules",
    });
  });

  it("returns a validation error for invalid input (blank name)", async () => {
    const { createSchedule } = await import("../schedules");
    expect(await createSchedule(validInput({ name: "" }))).toEqual({
      error: "Schedule name is required",
    });
  });

  it("requires a connection (neither id nor newConnection)", async () => {
    const { createSchedule } = await import("../schedules");
    expect(await createSchedule(validInput({ connectionId: null, newConnection: null }))).toEqual({
      error: "Select or create a System connection",
    });
  });

  it("returns error when the rubric is not owned by the team", async () => {
    builder.maybeSingle.mockResolvedValue({ data: null, error: null });
    const { createSchedule } = await import("../schedules");
    expect(await createSchedule(validInput())).toEqual({ error: "Rubric not found" });
  });

  it("returns error when an existing connectionId is not owned by the team", async () => {
    // 1st maybeSingle = rubric (found), 2nd = connection (not found).
    builder.maybeSingle
      .mockResolvedValueOnce({ data: { id: "rubric_1" }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    const { createSchedule } = await import("../schedules");
    const input = validInput({ newConnection: null, connectionId: CONNECTION_ID });
    expect(await createSchedule(input)).toEqual({ error: "Connection not found" });
  });

  it("propagates an inline connection creation error", async () => {
    mockInsertConnection.mockResolvedValue({ error: "Failed to store credential" });
    const { createSchedule } = await import("../schedules");
    expect(await createSchedule(validInput())).toEqual({ error: "Failed to store credential" });
  });

  it("cleans up an inline connection if next_run_at computation fails", async () => {
    builder.rpc.mockResolvedValue({ data: null, error: { message: "tz error" } });
    const { createSchedule } = await import("../schedules");
    expect(await createSchedule(validInput())).toEqual({
      error: "Failed to compute the schedule's next run time",
    });
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("id", "conn_1");
  });

  it("cleans up and errors when the schedule insert fails", async () => {
    builder.single.mockResolvedValue({ data: null, error: { message: "db" } });
    const { createSchedule } = await import("../schedules");
    expect(await createSchedule(validInput())).toEqual({ error: "Failed to create schedule" });
    // Only cleanup here is the inline connection (no schedule row was created).
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("id", "conn_1");
  });

  it("rolls back schedule + connection when inputs insert fails", async () => {
    builder._result = { data: null, error: { message: "constraint" } };
    const { createSchedule } = await import("../schedules");
    expect(await createSchedule(validInput())).toEqual({ error: "Failed to save the input set" });
    // schedule deleted by id, connection cleaned up by id.
    expect(builder.eq).toHaveBeenCalledWith("id", "sched_1");
    expect(builder.eq).toHaveBeenCalledWith("id", "conn_1");
  });

  it("computes next_run_at from the cadence and inserts the schedule", async () => {
    const { createSchedule } = await import("../schedules");
    const result = await createSchedule(validInput());
    expect(result).toEqual({ scheduleId: "sched_1" });
    expect(builder.rpc).toHaveBeenCalledWith(
      "compute_next_run_at",
      expect.objectContaining({
        p_frequency: "daily",
        p_local_hour: 9,
        p_timezone: "America/New_York",
      })
    );
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: "org_abc",
        created_by: "user_abc",
        rubric_id: RUBRIC_ID,
        connection_id: "conn_1",
        eval_type: "tabular",
        frequency: "daily",
        local_hour: 9,
        next_run_at: "2026-06-01T13:00:00.000Z",
      })
    );
  });

  it("inserts schedule_inputs with zero-based row_index and fires analytics", async () => {
    const { createSchedule } = await import("../schedules");
    await createSchedule(
      validInput({
        inputs: [
          { userInput: "a", expectedOutput: "x", retrievalContext: null },
          { userInput: "b", expectedOutput: null, retrievalContext: "ctx" },
        ],
      })
    );
    expect(builder.insert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ row_index: 0, user_input: "a", expected_output: "x" }),
        expect.objectContaining({ row_index: 1, user_input: "b", retrieval_context: "ctx" }),
      ])
    );
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "schedule.created",
        props: expect.objectContaining({ frequency: "daily", input_count: 2 }),
      }),
      { userId: "user_abc" }
    );
  });

  it("uses an existing connection without creating one", async () => {
    const { createSchedule } = await import("../schedules");
    const result = await createSchedule(
      validInput({ newConnection: null, connectionId: CONNECTION_ID })
    );
    expect(result).toEqual({ scheduleId: "sched_1" });
    expect(mockInsertConnection).not.toHaveBeenCalled();
  });
});

// --- listSchedules ---

describe("listSchedules", () => {
  it("returns empty array when unauthenticated", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const { listSchedules } = await import("../schedules");
    expect(await listSchedules()).toEqual([]);
  });

  it("scopes the query to the team and returns rows", async () => {
    builder._result = { data: [{ id: "sched_1", name: "Nightly" }], error: null };
    const { listSchedules } = await import("../schedules");
    const rows = await listSchedules();
    expect(rows).toEqual([{ id: "sched_1", name: "Nightly" }]);
    expect(builder.eq).toHaveBeenCalledWith("org_id", "org_abc");
  });
});

// --- getSchedule ---

describe("getSchedule", () => {
  it("returns null when unauthenticated", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const { getSchedule } = await import("../schedules");
    expect(await getSchedule("sched_1")).toBeNull();
  });

  it("returns null when the schedule is not found / not owned", async () => {
    builder.maybeSingle.mockResolvedValue({ data: null, error: null });
    const { getSchedule } = await import("../schedules");
    expect(await getSchedule("sched_1")).toBeNull();
  });

  it("returns the schedule with its recent runs", async () => {
    builder.maybeSingle.mockResolvedValue({ data: { id: "sched_1", name: "Nightly" }, error: null });
    builder._result = { data: [{ id: "run_1", status: "completed" }], error: null };
    const { getSchedule } = await import("../schedules");
    const result = await getSchedule("sched_1");
    expect(result?.schedule).toEqual({ id: "sched_1", name: "Nightly" });
    expect(result?.runs).toEqual([{ id: "run_1", status: "completed" }]);
  });
});

// --- setScheduleEnabled ---

describe("setScheduleEnabled", () => {
  it("throws for non-contributors", async () => {
    mockAuth.mockResolvedValue({ userId: "u", orgId: "o", orgRole: "org:member" });
    const { setScheduleEnabled } = await import("../schedules");
    await expect(setScheduleEnabled("sched_1", true)).rejects.toThrow(
      "Only contributors can change schedules"
    );
  });

  it("throws when the schedule is not found", async () => {
    builder.maybeSingle.mockResolvedValue({ data: null, error: null });
    const { setScheduleEnabled } = await import("../schedules");
    await expect(setScheduleEnabled("sched_1", true)).rejects.toThrow("Schedule not found");
  });

  it("recomputes next_run_at when enabling", async () => {
    builder.maybeSingle.mockResolvedValue({
      data: { frequency: "daily", local_hour: 9, days_of_week: null, day_of_month: null, timezone: "UTC" },
      error: null,
    });
    const { setScheduleEnabled } = await import("../schedules");
    await setScheduleEnabled("sched_1", true);
    expect(builder.rpc).toHaveBeenCalledWith("compute_next_run_at", expect.any(Object));
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, next_run_at: "2026-06-01T13:00:00.000Z" })
    );
  });

  it("disables without recomputing next_run_at", async () => {
    builder.maybeSingle.mockResolvedValue({
      data: { frequency: "daily", local_hour: 9, days_of_week: null, day_of_month: null, timezone: "UTC" },
      error: null,
    });
    const { setScheduleEnabled } = await import("../schedules");
    await setScheduleEnabled("sched_1", false);
    expect(builder.rpc).not.toHaveBeenCalled();
    const payload = builder.update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.enabled).toBe(false);
    expect(payload).not.toHaveProperty("next_run_at");
  });

  it("throws when the update fails", async () => {
    builder.maybeSingle.mockResolvedValue({
      data: { frequency: "daily", local_hour: 9, days_of_week: null, day_of_month: null, timezone: "UTC" },
      error: null,
    });
    builder._result = { data: null, error: { message: "db" } };
    const { setScheduleEnabled } = await import("../schedules");
    await expect(setScheduleEnabled("sched_1", false)).rejects.toThrow("Failed to update schedule");
  });
});

// --- deleteSchedule ---

describe("deleteSchedule", () => {
  it("throws for non-contributors", async () => {
    mockAuth.mockResolvedValue({ userId: "u", orgId: "o", orgRole: "org:member" });
    const { deleteSchedule } = await import("../schedules");
    await expect(deleteSchedule("sched_1")).rejects.toThrow(
      "Only contributors can delete schedules"
    );
  });

  it("scopes delete to id + org and fires analytics", async () => {
    const { deleteSchedule } = await import("../schedules");
    await deleteSchedule("sched_1");
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("id", "sched_1");
    expect(builder.eq).toHaveBeenCalledWith("org_id", "org_abc");
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ name: "schedule.deleted", props: { schedule_id: "sched_1" } }),
      { userId: "user_abc" }
    );
  });

  it("throws when delete fails", async () => {
    builder._result = { data: null, error: { message: "db" } };
    const { deleteSchedule } = await import("../schedules");
    await expect(deleteSchedule("sched_1")).rejects.toThrow("Failed to delete schedule");
  });
});
