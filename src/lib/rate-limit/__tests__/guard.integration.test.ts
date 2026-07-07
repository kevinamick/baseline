import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The lib under test (and the admin client it uses) import "server-only".
vi.mock("server-only", () => ({}));
// Keep the real RPC path; silence the side-effect deps.
vi.mock("@/lib/analytics/server", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/logging/server", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { hashKey, normalizeEmail, windowStart } from "../keys";
import { RATE_LIMITS } from "../config";

// guard.ts → admin.ts builds a Supabase client at import, which throws without
// env. Load it lazily inside beforeAll so this file imports cleanly (and skips)
// when there's no local DB — same contract as the other *.integration tests.
let checkLimit: typeof import("../guard").checkLimit;

/**
 * Integration tests for the rate-limit foundation (#209) against the real local
 * database — the atomic increment, that the guard actually limits, and that no
 * raw PII is persisted. Same env contract as the other *.integration tests:
 *
 *   set -a; source .env.local; set +a; npx vitest run guard.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

describe.skipIf(!hasDb)("rate-limit guard (integration)", () => {
  let db: SupabaseClient;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    // The default-on flag must be on for the guard to actually call the DB.
    delete process.env.RATE_LIMIT_ENABLED;
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    ({ checkLimit } = await import("../guard"));
  });

  afterAll(async () => {
    if (createdKeys.length) {
      await db.from("rate_limit_hits").delete().in("hashed_key", createdKeys);
    }
  });

  it("increments atomically under concurrency — no lost updates", async () => {
    const key = `concurrency-${crypto.randomUUID()}`;
    createdKeys.push(key);
    const window = windowStart(60_000);

    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        db
          .rpc("increment_rate_limit", {
            p_hashed_key: key,
            p_window_start: window,
            p_surface: "signIn",
            p_keytype: "ip",
          })
          .then(({ data, error }) => {
            if (error) throw new Error(error.message);
            return Number(data);
          })
      )
    );

    // Every concurrent call saw a distinct count 1..N, and the row lands at N.
    expect(new Set(results).size).toBe(N);
    expect(Math.max(...results)).toBe(N);

    const { data: row } = await db
      .from("rate_limit_hits")
      .select("count")
      .eq("hashed_key", key)
      .eq("window_start", window)
      .single();
    expect(row?.count).toBe(N);
  });

  it("allows up to the limit and rejects the next attempt in the window", async () => {
    const email = `limit-${crypto.randomUUID()}@example.com`;
    const limit = RATE_LIMITS.requestPasswordReset.email!.limit; // 3
    createdKeys.push(
      hashKey("requestPasswordReset", "email", normalizeEmail(email))
    );

    const outcomes: boolean[] = [];
    for (let i = 0; i < limit + 1; i++) {
      outcomes.push(await checkLimit("requestPasswordReset", "email", email));
    }

    // First `limit` allowed (false), the (limit+1)-th blocked (true).
    expect(outcomes.slice(0, limit)).toEqual(Array(limit).fill(false));
    expect(outcomes[limit]).toBe(true);
  });

  it("persists only the sha256 hash — never the raw email", async () => {
    const email = `pii-${crypto.randomUUID()}@example.com`;
    const expectedKey = hashKey(
      "requestPasswordReset",
      "email",
      normalizeEmail(email)
    );
    createdKeys.push(expectedKey);

    await checkLimit("requestPasswordReset", "email", email);

    const { data: rows } = await db
      .from("rate_limit_hits")
      .select("hashed_key, surface, keytype, count")
      .eq("hashed_key", expectedKey);

    expect(rows).toHaveLength(1);
    expect(rows![0].hashed_key).toBe(expectedKey);
    expect(rows![0].hashed_key).not.toContain(email);
    // surface/keytype are intentionally cleartext for tuning.
    expect(rows![0].surface).toBe("requestPasswordReset");
    expect(rows![0].keytype).toBe("email");

    // And no row anywhere stores the raw address.
    const { data: leak } = await db
      .from("rate_limit_hits")
      .select("hashed_key")
      .eq("hashed_key", email);
    expect(leak ?? []).toHaveLength(0);
  });
});
