import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Integration tests for the Access Code claim SQL (ADR-0017, #426): the
 * atomicity guarantee — the cap check and the redemption-count increment are
 * ONE guarded write, so concurrent claims can never jointly over-admit a code
 * — lives in Postgres, so it's verified against the real local database, not
 * mocks. Skipped when no local Supabase env is available (CI without a DB);
 * run locally with the .env.local vars exported:
 *
 *   set -a; source .env.local; set +a; npx vitest run claim-access-code.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

interface ClaimRow {
  claimed: boolean;
  status: "claimed" | "not_found" | "expired" | "exhausted";
  access_code_id: string | null;
  trial_days: number | null;
  stripe_coupon_id: string | null;
  plan_slug: string | null;
}

describe.skipIf(!hasDb)("claim_access_code (integration)", () => {
  let db: SupabaseClient;
  const createdCodeIds: string[] = [];

  beforeAll(() => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });
  });

  afterAll(async () => {
    if (createdCodeIds.length > 0) {
      await db.from("access_codes").delete().in("id", createdCodeIds);
    }
  });

  async function mintCode(overrides: {
    maxRedemptions?: number;
    expiresAt?: string | null;
    trialDays?: number | null;
    stripeCouponId?: string | null;
    planSlug?: string | null;
  } = {}): Promise<{ id: string; code: string }> {
    const code = `TEST-${crypto.randomUUID()}`;
    const { data, error } = await db
      .from("access_codes")
      .insert({
        code,
        max_redemptions: overrides.maxRedemptions ?? 3,
        expires_at: overrides.expiresAt ?? null,
        trial_days: overrides.trialDays ?? null,
        stripe_coupon_id: overrides.stripeCouponId ?? null,
        plan_slug: overrides.planSlug ?? null,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`mint failed: ${error?.message}`);
    createdCodeIds.push(data.id);
    return { id: data.id, code };
  }

  async function claim(code: string): Promise<ClaimRow> {
    const { data, error } = await db.rpc("claim_access_code", { p_code: code });
    if (error) throw new Error(error.message);
    return (Array.isArray(data) ? data[0] : data) as ClaimRow;
  }

  async function redeemedCount(id: string): Promise<number> {
    const { data, error } = await db
      .from("access_codes")
      .select("redeemed_count")
      .eq("id", id)
      .single();
    if (error) throw new Error(error.message);
    return data!.redeemed_count as number;
  }

  it("claims a fresh code and returns its grant fields", async () => {
    const { code, id } = await mintCode({
      maxRedemptions: 5,
      trialDays: 14,
      stripeCouponId: "coupon_abc",
      planSlug: "builder",
    });

    const result = await claim(code);

    expect(result).toMatchObject({
      claimed: true,
      status: "claimed",
      access_code_id: id,
      trial_days: 14,
      stripe_coupon_id: "coupon_abc",
      plan_slug: "builder",
    });
    expect(await redeemedCount(id)).toBe(1);
  });

  it("matches case-insensitively", async () => {
    const { code, id } = await mintCode({ maxRedemptions: 5 });
    const result = await claim(code.toLowerCase());
    expect(result.claimed).toBe(true);
    expect(result.access_code_id).toBe(id);
  });

  it("returns not_found for an unrecognized code", async () => {
    const result = await claim(`NOPE-${crypto.randomUUID()}`);
    expect(result).toMatchObject({ claimed: false, status: "not_found", access_code_id: null });
  });

  it("returns expired (and does not increment) for an expired code, distinct from exhausted", async () => {
    const { code, id } = await mintCode({
      maxRedemptions: 5,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const result = await claim(code);
    expect(result).toMatchObject({ claimed: false, status: "expired", access_code_id: id });
    expect(await redeemedCount(id)).toBe(0);
  });

  it("returns exhausted (and does not increment further) once max_redemptions is reached, distinct from expired", async () => {
    const { code, id } = await mintCode({ maxRedemptions: 1 });
    const first = await claim(code);
    expect(first.claimed).toBe(true);

    const second = await claim(code);
    expect(second).toMatchObject({ claimed: false, status: "exhausted", access_code_id: id });
    expect(await redeemedCount(id)).toBe(1);
  });

  it("never over-admits a cap-N code under concurrent claims", async () => {
    const CAP = 5;
    const ATTEMPTS = 12;
    const { code, id } = await mintCode({ maxRedemptions: CAP });

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () => claim(code))
    );

    const succeeded = results.filter((r) => r.claimed);
    const exhausted = results.filter((r) => !r.claimed && r.status === "exhausted");
    expect(succeeded).toHaveLength(CAP);
    expect(exhausted).toHaveLength(ATTEMPTS - CAP);
    expect(await redeemedCount(id)).toBe(CAP);
  });

  it("release_access_code_claim hands a slot back so a subsequent claim can succeed", async () => {
    const { code, id } = await mintCode({ maxRedemptions: 1 });
    const first = await claim(code);
    expect(first.claimed).toBe(true);
    expect((await claim(code)).status).toBe("exhausted");

    const { error: releaseError } = await db.rpc("release_access_code_claim", {
      p_access_code_id: id,
    });
    expect(releaseError).toBeNull();
    expect(await redeemedCount(id)).toBe(0);

    const afterRelease = await claim(code);
    expect(afterRelease.claimed).toBe(true);
    expect(await redeemedCount(id)).toBe(1);
  });

  it("release_access_code_claim floors at 0 (never goes negative on a duplicate release)", async () => {
    const { id } = await mintCode({ maxRedemptions: 1 });
    await db.rpc("release_access_code_claim", { p_access_code_id: id });
    await db.rpc("release_access_code_claim", { p_access_code_id: id });
    expect(await redeemedCount(id)).toBe(0);
  });
});
