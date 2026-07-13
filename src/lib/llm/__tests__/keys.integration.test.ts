import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The lib under test imports "server-only".
vi.mock("server-only", () => ({}));

/**
 * Integration tests for BYO provider keys (#184): the Vault round-trip, the
 * write-only guarantee, the RLS denial matrix, and the secret lifecycle
 * (replace-swaps-and-purges, delete-trigger-purges) all live in Postgres, so
 * they're verified against the real local database. Skipped when no local
 * Supabase env is available; run locally with the .env.local vars exported:
 *
 *   set -a; source .env.local; set +a; npx vitest run keys.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const hasDb = Boolean(url && serviceKey);

describe.skipIf(!hasDb)("provider keys (integration)", () => {
  let db: SupabaseClient;
  let orgId: string;
  let userId: string;
  let lib: typeof import("../keys");

  async function secretIdFor(provider: string): Promise<string | null> {
    const { data } = await db
      .from("provider_keys")
      .select("secret_id")
      .eq("org_id", orgId)
      .eq("provider", provider)
      .maybeSingle();
    return (data?.secret_id as string) ?? null;
  }

  async function decrypt(secretId: string): Promise<string | null> {
    const { data } = await db.rpc("get_provider_secret", { p_secret_id: secretId });
    return (data as string) ?? null;
  }

  async function secretExists(secretId: string): Promise<boolean> {
    // The decrypted view only lists live secrets — a purged one decrypts to null.
    return (await decrypt(secretId)) != null;
  }

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });

    const { data: org, error: orgError } = await db
      .from("organizations")
      .insert({ name: "Provider Keys Integration Org" })
      .select("id")
      .single();
    if (orgError) throw new Error(orgError.message);
    orgId = org.id;

    const { data: authUser, error: authError } = await db.auth.admin.createUser({
      email: `provider-keys-${crypto.randomUUID()}@example.com`,
      password: crypto.randomUUID(),
      email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    userId = authUser.user.id;
    await db.from("users").upsert({ id: userId }, { onConflict: "id" });

    lib = await import("../keys");
  });

  afterAll(async () => {
    if (orgId) await db.from("organizations").delete().eq("id", orgId);
    if (userId) await db.auth.admin.deleteUser(userId);
  });

  it("stores a key in Vault and round-trips it (only the masked tail is public)", async () => {
    const result = await lib.upsertProviderKey(orgId, userId, "anthropic", "sk-ant-secretkey1234");
    expect(result).toEqual({ last4: "1234" });

    // The public row holds a secret reference + last4 — never the plaintext.
    const { data: row } = await db
      .from("provider_keys")
      .select("secret_id, last4")
      .eq("org_id", orgId)
      .eq("provider", "anthropic")
      .single();
    expect(row!.last4).toBe("1234");
    expect(JSON.stringify(row)).not.toContain("sk-ant-secretkey1234");

    // The worker's read RPC decrypts the real key back.
    expect(await decrypt(row!.secret_id as string)).toBe("sk-ant-secretkey1234");

    // The masked summary list never carries the key.
    const summaries = await lib.listProviderKeys(orgId);
    expect(summaries).toContainEqual(
      expect.objectContaining({ provider: "anthropic", last4: "1234" })
    );
    expect(JSON.stringify(summaries)).not.toContain("sk-ant-secretkey1234");
  });

  it("replacing a key swaps the secret and purges the old one", async () => {
    const oldSecret = await secretIdFor("anthropic");
    expect(oldSecret).toBeTruthy();

    const result = await lib.upsertProviderKey(orgId, userId, "anthropic", "sk-ant-rotatedkey9999");
    expect(result).toEqual({ last4: "9999" });

    const newSecret = await secretIdFor("anthropic");
    expect(newSecret).not.toBe(oldSecret);
    expect(await decrypt(newSecret!)).toBe("sk-ant-rotatedkey9999");
    // The old secret is gone — no orphan left in Vault.
    expect(await secretExists(oldSecret!)).toBe(false);
  });

  it("deleting the row purges its secret via the trigger", async () => {
    const secret = await secretIdFor("anthropic");
    expect(secret).toBeTruthy();

    const result = await lib.deleteProviderKeyRow(orgId, "anthropic");
    expect(result).toEqual({});

    expect(await secretIdFor("anthropic")).toBeNull();
    expect(await secretExists(secret!)).toBe(false);
  });

  it("enforces one key per (org, provider)", async () => {
    // Both must pass the #342 format gate (sk-ant- prefix, >= 20 chars) to reach
    // the row-level uniqueness this test asserts — the value itself is irrelevant.
    await lib.upsertProviderKey(orgId, userId, "anthropic", "sk-ant-firstkey000001");
    await lib.upsertProviderKey(orgId, userId, "anthropic", "sk-ant-secondkey00002");
    const { data: rows } = await db
      .from("provider_keys")
      .select("id")
      .eq("org_id", orgId)
      .eq("provider", "anthropic");
    expect(rows).toHaveLength(1);
  });

  it.skipIf(!anonKey)("RLS denies anon access to the table and the vault RPCs", async () => {
    const anon = createClient(url!, anonKey!, { auth: { persistSession: false } });

    // RLS-on with no policy: anon selects return no rows (never another Team's key).
    const { data: rows } = await anon.from("provider_keys").select("secret_id, last4");
    expect(rows ?? []).toHaveLength(0);

    // The vault read RPC's EXECUTE is revoked from anon — calling it errors.
    const secret = await secretIdFor("anthropic");
    const { error } = await anon.rpc("get_provider_secret", { p_secret_id: secret });
    expect(error).toBeTruthy();

    // And anon can't mint a secret either.
    const { error: createErr } = await anon.rpc("create_provider_secret", {
      p_secret: "x",
      p_name: "y",
    });
    expect(createErr).toBeTruthy();
  });
});
