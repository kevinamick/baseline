import { describe, it, expect, vi, beforeEach } from "vitest";

// Dedicated coverage for the unified terminal seam (#378): the guarded transition and the
// notify (log + best-effort email) contract — across both run kinds and every outcome.
// evalrun/activities.test.ts and gepa/activities.*.test.ts continue to cover the six thin
// adapters end to end (their own patch shapes, log content, email payloads); this file targets
// the shared seam's own guarantees directly, with a mock precise enough to actually exercise
// the guarded transition (unlike the per-writer mocks, which don't discriminate on `.eq`/`.in`
// filter values).

interface RecordedCall {
  table: string;
  method: string;
  args: unknown[];
}

const db = vi.hoisted(() => ({
  calls: [] as RecordedCall[],
  rpc: vi.fn(),
  rows: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      let filterId: string | undefined;
      let filterStatuses: string[] | undefined;
      let pendingPatch: Record<string, unknown> | undefined;
      let selectCols = "id";

      const builder = {
        update: (patch: Record<string, unknown>) => {
          db.calls.push({ table, method: "update", args: [patch] });
          pendingPatch = patch;
          return builder;
        },
        select: (cols: string) => {
          db.calls.push({ table, method: "select", args: [cols] });
          selectCols = cols;
          return builder;
        },
        eq: (col: string, value: string) => {
          db.calls.push({ table, method: "eq", args: [col, value] });
          if (col === "id") filterId = value;
          return builder;
        },
        in: (col: string, values: string[]) => {
          db.calls.push({ table, method: "in", args: [col, values] });
          if (col === "status") filterStatuses = values;
          return builder;
        },
        maybeSingle: async () => {
          const row = filterId ? db.rows.get(`${table}:${filterId}`) : undefined;
          // A bare read (currentTerminalStatus: no pendingPatch, no status filter) just returns
          // the row's current shape under whatever columns were selected.
          if (!pendingPatch) {
            if (!row) return { data: null, error: null };
            return { data: pick(row, selectCols), error: null };
          }
          // A seeded `__updateError` simulates the write itself failing (connection reset,
          // etc.) — used to pin each outcome's exact thrown message.
          if (row?.__updateError) return { data: null, error: { message: row.__updateError } };
          // A guarded UPDATE: only applies (and only returns a row) when the row's current
          // status is one of fromStatuses — the guarded transition under real test.
          if (!row || !filterStatuses?.includes(row.status as string)) {
            return { data: null, error: null };
          }
          Object.assign(row, pendingPatch);
          return { data: pick(row, selectCols), error: null };
        },
      };
      return builder;
    },
    rpc: db.rpc,
  }),
}));

function pick(row: Record<string, unknown>, cols: string): Record<string, unknown> {
  const keys = cols.split(",").map((c) => c.trim());
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in row) out[k] = row[k];
  return out;
}

import { settleTerminalRun, RUN_KINDS, TERMINAL_OUTCOMES } from "./settle-terminal-run.js";

function seedRow(table: string, id: string, row: Record<string, unknown>) {
  db.rows.set(`${table}:${id}`, { id, ...row });
}

beforeEach(() => {
  db.calls = [];
  db.rows = new Map();
  // Mutate the SAME mock function object (never reassign db.rpc): the supabase client object
  // literal captured `rpc: db.rpc` once at module-import time, so a later `db.rpc = vi.fn()`
  // here would silently orphan that reference.
  db.rpc.mockReset();
  db.rpc.mockResolvedValue({ error: null });
});

describe("single-source enums", () => {
  it("RUN_KINDS and TERMINAL_OUTCOMES are the one definition (no duplicated unions)", () => {
    expect(RUN_KINDS).toEqual(["eval", "optimization"]);
    expect(TERMINAL_OUTCOMES).toEqual(["completed", "failed", "skipped"]);
  });
});

describe("the guarded transition", () => {
  it("performs the transition and returns true when the run is in fromStatuses", async () => {
    seedRow("eval_runs", "run-1", { status: "running" });
    const performed = await settleTerminalRun({
      runKind: "eval",
      runId: "run-1",
      outcome: "completed",
      fromStatuses: ["running"],
    });
    expect(performed).toBe(true);
    expect(db.rows.get("eval_runs:run-1")?.status).toBe("completed");
  });

  it("an already-terminal run is left alone: no transition, no notify", async () => {
    seedRow("eval_runs", "run-1", { status: "completed" });
    const notifyRun = vi.fn();
    const performed = await settleTerminalRun({
      runKind: "eval",
      runId: "run-1",
      outcome: "failed",
      fromStatuses: ["queued", "running"],
      notify: { run: notifyRun, onError: vi.fn() },
    });
    expect(performed).toBe(false);
    // The row wasn't clobbered back to 'failed' by a retried/racing call.
    expect(db.rows.get("eval_runs:run-1")?.status).toBe("completed");
    expect(notifyRun).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

});

describe("notify: never fails the settlement", () => {
  it("an email/log failure inside notify.run is caught and handed to onError, never thrown", async () => {
    seedRow("eval_runs", "run-1", { status: "running" });
    const onError = vi.fn();
    await expect(
      settleTerminalRun({
        runKind: "eval",
        runId: "run-1",
        outcome: "completed",
        fromStatuses: ["running"],
        notify: {
          run: async () => {
            throw new Error("smtp down");
          },
          onError,
        },
      })
    ).resolves.toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "smtp down" }));
  });

  it("runs notify with the transitioned row when the transition succeeds", async () => {
    seedRow("optimization_runs", "run-1", { status: "running", org_id: "org-9", created_at: "t" });
    const notifyRun = vi.fn();
    await settleTerminalRun({
      runKind: "optimization",
      runId: "run-1",
      outcome: "completed",
      fromStatuses: ["running"],
      selectColumns: "id, created_at, org_id",
      notify: { run: notifyRun, onError: vi.fn() },
    });
    expect(notifyRun).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: "org-9", created_at: "t" })
    );
  });
});

describe("afterTransition", () => {
  it("runs only when the transition happened, and is NOT swallowed on error", async () => {
    seedRow("eval_runs", "run-1", { status: "running" });
    const afterTransition = vi.fn().mockRejectedValue(new Error("capture blew up"));
    await expect(
      settleTerminalRun({
        runKind: "eval",
        runId: "run-1",
        outcome: "failed",
        fromStatuses: ["running"],
        afterTransition,
      })
    ).rejects.toThrow("capture blew up");
    expect(afterTransition).toHaveBeenCalled();
  });

  it("is skipped when the run was already terminal", async () => {
    seedRow("eval_runs", "run-1", { status: "completed" });
    const afterTransition = vi.fn();
    await settleTerminalRun({
      runKind: "eval",
      runId: "run-1",
      outcome: "failed",
      fromStatuses: ["queued", "running"],
      afterTransition,
    });
    expect(afterTransition).not.toHaveBeenCalled();
  });
});

describe("transition-write error messages (preserve each writer's pre-existing wording)", () => {
  it.each([
    ["eval", "completed", "Failed to complete eval run: write blew up"],
    ["eval", "failed", "Failed to mark eval run failed: write blew up"],
    ["eval", "skipped", "Failed to mark eval run skipped: write blew up"],
    ["optimization", "completed", "Failed to complete optimization run: write blew up"],
    ["optimization", "failed", "Failed to mark optimization run failed: write blew up"],
  ] as const)("%s / %s -> %s", async (runKind, outcome, expected) => {
    const table = runKind === "eval" ? "eval_runs" : "optimization_runs";
    seedRow(table, "run-1", { status: "running", __updateError: "write blew up" });
    await expect(
      settleTerminalRun({
        runKind,
        runId: "run-1",
        outcome,
        fromStatuses: ["running"],
      })
    ).rejects.toThrow(expected);
  });
});
