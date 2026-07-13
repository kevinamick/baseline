import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SIGNUP_PASS_REJECTION_MESSAGE } from "../rejection";

/**
 * Integration tests for the signup-pass consume SQL (#487, #489, ADR-0017):
 * `before_user_created_hook` is the GoTrue auth hook that closes the direct
 * /auth/v1/signup + /auth/v1/otp bypass — it must admit a self-service email
 * creation exactly once per valid pass whose NONCE matches, and its single-use
 * guarantee (row-locked guarded update, same discipline as claim_access_code)
 * lives in Postgres, so it's verified against the real local database, not
 * mocks. Driven through the same PostgREST rpc surface GoTrue's pg-functions
 * transport ultimately reaches, with the exact event payload shape captured
 * empirically from GoTrue v2.190.0 (`{user: {email, app_metadata,
 * user_metadata, ...}, metadata: {...}}`). Skipped when no local Supabase env
 * is available (CI without a DB); run locally with the .env.local vars
 * exported:
 *
 *   set -a; source .env.local; set +a; npx vitest run consume-signup-pass.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

// The hook's rejection payload — the message is single-sourced from
// ../rejection.ts (which a parity test holds equal to the migration SQL).
const REJECTION = {
  error: { http_code: 403, message: SIGNUP_PASS_REJECTION_MESSAGE },
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
    overrides: { expiresAt?: string; nonce?: string } = {}
  ): Promise<{ id: string; nonce: string }> {
    mintedEmails.push(email);
    const nonce = overrides.nonce ?? crypto.randomUUID();
    const { data, error } = await db
      .from("signup_passes")
      .insert({
        email,
        nonce,
        ...(overrides.expiresAt ? { expires_at: overrides.expiresAt } : {}),
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`mint failed: ${error?.message}`);
    return { id: data.id as string, nonce };
  }

  /**
   * Invoke the hook exactly as GoTrue's pg-functions transport does. `nonce`
   * lands in user_metadata (where options.data arrives, verified empirically);
   * `provider` in app_metadata (GoTrue-set, unforgeable via /signup).
   */
  async function invokeHook(
    email: string,
    opts: { nonce?: string; provider?: string } = {}
  ): Promise<Record<string, unknown>> {
    const { data, error } = await db.rpc("before_user_created_hook", {
      event: {
        user: {
          email,
          aud: "authenticated",
          is_anonymous: false,
          app_metadata: { provider: opts.provider ?? "email" },
          user_metadata: opts.nonce !== undefined ? { signup_nonce: opts.nonce } : {},
        },
        metadata: { name: "before-user-created", uuid: crypto.randomUUID() },
      },
    });
    if (error) throw new Error(error.message);
    return data as Record<string, unknown>;
  }

  it("admits a creation with a valid pass + matching nonce ({} return) and marks the pass consumed", async () => {
    const email = testEmail();
    const { id: passId, nonce } = await mintPass(email);

    await expect(invokeHook(email, { nonce })).resolves.toEqual({});

    const { data } = await db
      .from("signup_passes")
      .select("consumed_at")
      .eq("id", passId)
      .single();
    expect(data?.consumed_at).not.toBeNull();
  });

  it("rejects when no pass exists for the email", async () => {
    await expect(invokeHook(testEmail(), { nonce: crypto.randomUUID() })).resolves.toEqual(
      REJECTION
    );
  });

  it("rejects a valid pass presented with the WRONG nonce, leaving it unconsumed (#489 takeover fix)", async () => {
    const email = testEmail();
    const { id: passId } = await mintPass(email);
    // Attacker racing the victim: right email, but they cannot know the nonce.
    await expect(invokeHook(email, { nonce: "attacker-guess" })).resolves.toEqual(REJECTION);
    const { data } = await db
      .from("signup_passes")
      .select("consumed_at")
      .eq("id", passId)
      .single();
    expect(data?.consumed_at).toBeNull();
  });

  it("rejects a valid pass presented with NO nonce at all", async () => {
    const email = testEmail();
    await mintPass(email);
    await expect(invokeHook(email)).resolves.toEqual(REJECTION);
  });

  it("admits a federated (non-email provider) creation with no pass at all (OAuth gate-lift, #489)", async () => {
    // OAuth users are created during the provider token exchange and never mint
    // a pass; the provider is GoTrue-set and unforgeable via /signup.
    await expect(
      invokeHook(testEmail(), { provider: "google" })
    ).resolves.toEqual({});
  });

  it("rejects a replay: a consumed pass never admits a second creation", async () => {
    const email = testEmail();
    const { nonce } = await mintPass(email);
    await expect(invokeHook(email, { nonce })).resolves.toEqual({});
    await expect(invokeHook(email, { nonce })).resolves.toEqual(REJECTION);
  });

  it("rejects an expired pass (and leaves it unconsumed)", async () => {
    const email = testEmail();
    const { id: passId, nonce } = await mintPass(email, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await expect(invokeHook(email, { nonce })).resolves.toEqual(REJECTION);
    const { data } = await db
      .from("signup_passes")
      .select("consumed_at")
      .eq("id", passId)
      .single();
    expect(data?.consumed_at).toBeNull();
  });

  it("rejects an event with no email at all", async () => {
    const { data, error } = await db.rpc("before_user_created_hook", {
      event: {
        user: { app_metadata: { provider: "email" }, user_metadata: { signup_nonce: "x" } },
        metadata: { name: "before-user-created" },
      },
    });
    expect(error).toBeNull();
    expect(data).toEqual(REJECTION);
  });

  it("matches the pass case-insensitively (GoTrue lowercases; belt-and-suspenders)", async () => {
    const email = testEmail();
    // Minted mixed-case (the app normalizes, but the SQL must not depend on it).
    const mixed = email.replace("pass-int", "Pass-Int");
    const { nonce } = await mintPass(mixed);
    await expect(invokeHook(email, { nonce })).resolves.toEqual({});
  });

  it("admits exactly ONE of many concurrent creations per pass (single-use under concurrency)", async () => {
    const email = testEmail();
    const { nonce } = await mintPass(email);
    const ATTEMPTS = 12;

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () => invokeHook(email, { nonce }))
    );

    const admitted = results.filter((r) => !("error" in r));
    const rejected = results.filter((r) => "error" in r);
    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(ATTEMPTS - 1);
  });

  it("consumes the newest valid pass when several exist (a retry within the TTL still works)", async () => {
    const email = testEmail();
    const older = await mintPass(email);
    // Ensure a strictly newer created_at for the second pass.
    await new Promise((r) => setTimeout(r, 20));
    const newer = await mintPass(email);

    // The newest pass's nonce is the one the app's latest attempt carries.
    await expect(invokeHook(email, { nonce: newer.nonce })).resolves.toEqual({});

    const { data } = await db
      .from("signup_passes")
      .select("id, consumed_at")
      .in("id", [older.id, newer.id]);
    const byId = new Map((data ?? []).map((row) => [row.id, row.consumed_at]));
    expect(byId.get(newer.id)).not.toBeNull();
    expect(byId.get(older.id)).toBeNull();
  });
});
