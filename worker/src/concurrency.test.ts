import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
  it("runs up to `limit` calls in flight and returns results in input order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [0, 1, 2, 3, 4, 5];

    const results = await mapWithConcurrency(items, 3, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield so siblings get a chance to start before this one settles.
      await new Promise<void>((r) => setTimeout(r, 1));
      inFlight -= 1;
      return n * 10;
    });

    // Concurrency was honored (more than one ran at once) but capped at the limit.
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    // Results follow input order regardless of completion order.
    expect(results).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it("stops pulling new items after the first rejection — the rest of the queue is never executed", async () => {
    // This is the metering-safety guarantee: when one call fails (e.g. a managed-spend cap
    // throw), surviving runners must not keep draining the queue and incurring more priced
    // calls. Only the calls already in flight at the moment of failure settle.
    const started: number[] = [];
    const items = [0, 1, 2, 3, 4, 5];

    // Item 0 rejects on the first microtask; the surviving runner's item is slower, so by the
    // time it loops to pull the next item the failure flag is already set.
    const run = mapWithConcurrency(items, 2, async (n) => {
      started.push(n);
      if (n === 0) {
        throw new Error("boom");
      }
      await new Promise<void>((r) => setTimeout(r, 5));
      return n;
    });

    await expect(run).rejects.toThrow("boom");

    // Give any surviving runner ample time to (incorrectly) keep draining the queue. The
    // remaining items each take ~5ms serially; 100ms is well beyond a full drain. With the fix
    // the failure flag halts the survivor, so nothing more is pulled.
    await new Promise<void>((r) => setTimeout(r, 100));

    // Only the two items in flight when item 0 failed were ever started. Items 2..5 — the rest
    // of the queue — were never pulled, so no further work (or metering) happened.
    expect(started.sort((a, b) => a - b)).toEqual([0, 1]);
  });
});
