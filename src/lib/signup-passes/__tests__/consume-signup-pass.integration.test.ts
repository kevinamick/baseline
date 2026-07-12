import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Integration tests for the signup-pass consume SQL (#487, ADR-0017):
 * `before_user_created_hook` is the GoTrue auth hook that closes the direct
 * /auth/v1/signup bypass — it must admit a creation exactly once per valid
 * pass, and its single-use guarantee (row-locked guarded update, same
 * discipline as claim_access_code) lives in Postgres, so it's verified
 * against the real local database, not mocks. Driven through the same
 * PostgREST rpc surface GoTrue's pg-functions transport ultimately reaches,
 * with the exact event payload shape captured empirically from GoTrue
 * v2.190.0 (`{user: {email, ...}, metadata: {...}}`). Skipped when no local
 * Supabase env is available (CI without a DB); run locally with the
 * .env.local vars exported:
 *
 *   set -a; source .env.local; set +a; npx vitest run consume-signup-pass.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

// The hook's rejection payload — must stay byte-identical to `v_reject` in
// supabase/migrations/20260712000000_signup_passes.sql and to
// SIGNUP_PASS_REJECTION_MESSAGE in ../mint.ts.
const REJECTION = {
  error: { http_code: 403, message: "Sign-up is not available." },
};

describe.skipIf(!hasDb)("before_user_created_hook (integration)", () => {
  let db: SupabaseClient;
  const mintedEmails: string[] = [];

  beforeAll(() => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });
  });

  afterAll(async () => {
    if (mintedEmails.length > 0) {
      await db.from("signup_passes").delete().in("email", mintedEmails);
    }
  });

  function testEmail(): string {
    return `pass-int-${crypto.randomUUID()}@baseline.test`;
  }

  async function mintPass(
    email: string,
    overrides: { expiresAt?: string } = {}
  ): Promise<string> {
    mintedEmails.push(email);
    const { data, error } = await db
      .from("signup_passes")
      .insert({ email, ...(overrides.expiresAt ? { expires_at: overrides.expiresAt } : {}) })
      .select("id")
      .single();
    if (error || !data) throw new Error(`mint failed: ${error?.message}`);
    return data.id as string;
  }

  /** Invoke the hook exactly as GoTrue's pg-functions transport does. */
  async function invokeHook(email: string): Promise<Record<string, unknown>> {
    const { data, error } = await db.rpc("before_user_created_hook", {
      event: {
        user: { email, aud: "authenticated", is_anonymous: false },
        metadata: { name: "before-user-created", uuid: crypto.randomUUID() },
      },
    });
    if (error) throw new Error(error.message);
    return data as Record<string, unknown>;
  }

  it("admits a creation with a valid pass ({} return) and marks the pass consumed", async () => {
    const email = testEmail();
    const passId = await mintPass(email);

    await expect(invokeHook(email)).resolves.toEqual({});

    const { data } = await db
      .from("signup_passes")
      .select("consumed_at")
      .eq("id", passId)
      .single();
    expect(data?.consumed_at).not.toBeNull();
  });

  it("rejects when no pass exists for the email", async () => {
    await expect(invokeHook(testEmail())).resolves.toEqual(REJECTION);
  });

  it("rejects a replay: a consumed pass never admits a second creation", async () => {
    const email = testEmail();
    await mintPass(email);
    await expect(invokeHook(email)).resolves.toEqual({});
    await expect(invokeHook(email)).resolves.toEqual(REJECTION);
  });

  it("rejects an expired pass (and leaves it unconsumed)", async () => {
    const email = testEmail();
    const passId = await mintPass(email, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await expect(invokeHook(email)).resolves.toEqual(REJECTION);
    const { data } = await db
      .from("signup_passes")
      .select("consumed_at")
      .eq("id", passId)
      .single();
    expect(data?.consumed_at).toBeNull();
  });

  it("rejects an event with no email at all", async () => {
    const { data, error } = await db.rpc("before_user_created_hook", {
      event: { user: {}, metadata: { name: "before-user-created" } },
    });
    expect(error).toBeNull();
    expect(data).toEqual(REJECTION);
  });

  it("matches the pass case-insensitively (GoTrue lowercases; belt-and-suspenders)", async () => {
    const email = testEmail();
    // Minted mixed-case (the app normalizes, but the SQL must not depend on it).
    const mixed = email.replace("pass-int", "Pass-Int");
    await mintPass(mixed);
    await expect(invokeHook(email)).resolves.toEqual({});
  });

  it("admits exactly ONE of many concurrent creations per pass (single-use under concurrency)", async () => {
    const email = testEmail();
    await mintPass(email);
    const ATTEMPTS = 12;

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () => invokeHook(email))
    );

    const admitted = results.filter((r) => !("error" in r));
    const rejected = results.filter((r) => "error" in r);
    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(ATTEMPTS - 1);
  });

  it("consumes the newest valid pass when several exist (a retry within the TTL still works)", async () => {
    const email = testEmail();
    const olderId = await mintPass(email);
    // Ensure a strictly newer created_at for the second pass.
    await new Promise((r) => setTimeout(r, 20));
    const newerId = await mintPass(email);

    await expect(invokeHook(email)).resolves.toEqual({});

    const { data } = await db
      .from("signup_passes")
      .select("id, consumed_at")
      .in("id", [olderId, newerId]);
    const byId = new Map((data ?? []).map((row) => [row.id, row.consumed_at]));
    expect(byId.get(newerId)).not.toBeNull();
    expect(byId.get(olderId)).toBeNull();
  });
});
