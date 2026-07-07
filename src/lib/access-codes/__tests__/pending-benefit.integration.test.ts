import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

/**
 * Integration tests for the READ-ONLY pending-benefit lookup (ADR-0017 slice
 * 4, #428) against the real local database — proves it never consumes the
 * grant it reads, the one property that can't be faked with a mock (same
 * rationale as checkout-benefit.integration.test.ts, which this file sits
 * beside). The coupon-description composition
 * (`getPendingAccessCodeBenefitView`) calls the real Stripe API for a
 * coupon's display shape, so it's exercised at the unit level
 * (pending-benefit.test.ts, with `describeCoupon` mocked) instead — this
 * file covers the DB-backed `getPendingAccessCodeBenefit` only. Skipped when
 * no local Supabase env is available (CI without a DB); run locally with the
 * .env.local vars exported:
 *
 *   set -a; source .env.local; set +a; npx vitest run pending-benefit.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

type LookupFn = (typeof import("../pending-benefit"))["getPendingAccessCodeBenefit"];

describe.skipIf(!hasDb)("getPendingAccessCodeBenefit (integration)", () => {
  let db: SupabaseClient;
  let getPendingAccessCodeBenefit: LookupFn;
  const createdOrgIds: string[] = [];
  const createdCodeIds: string[] = [];

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    ({ getPendingAccessCodeBenefit } = await import("../pending-benefit"));
  });

  afterAll(async () => {
    if (createdOrgIds.length > 0) {
      await db.from("organizations").delete().in("id", createdOrgIds);
    }
    if (createdCodeIds.length > 0) {
      // access_code_redemptions cascades off access_codes.
      await db.from("access_codes").delete().in("id", createdCodeIds);
    }
  });

  async function newOrg(): Promise<string> {
    const { data, error } = await db
      .from("organizations")
      .insert({ name: "428 pending-benefit org" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`org insert failed: ${error?.message}`);
    createdOrgIds.push(data.id);
    return data.id;
  }

  async function mintCode(overrides: {
    trialDays?: number | null;
    stripeCouponId?: string | null;
    planSlug?: string | null;
  } = {}): Promise<string> {
    const code = `TEST-${crypto.randomUUID()}`;
    const { data, error } = await db
      .from("access_codes")
      .insert({
        code,
        max_redemptions: 5,
        trial_days: overrides.trialDays ?? 14,
        stripe_coupon_id: overrides.stripeCouponId ?? null,
        plan_slug: overrides.planSlug ?? null,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`mint failed: ${error?.message}`);
    createdCodeIds.push(data.id);
    return data.id;
  }

  async function bindRedemption(accessCodeId: string, orgId: string): Promise<string> {
    const { data: authUser, error: authErr } = await db.auth.admin.createUser({
      email: `pending-benefit-${crypto.randomUUID()}@example.com`,
      password: crypto.randomUUID(),
      email_confirm: true,
    });
    if (authErr) throw new Error(authErr.message);
    const userId = authUser.user.id;
    await db.from("users").upsert({ id: userId }, { onConflict: "id" });

    const { data, error } = await db
      .from("access_code_redemptions")
      .insert({ access_code_id: accessCodeId, user_id: userId, org_id: orgId })
      .select("id")
      .single();
    if (error || !data) throw new Error(`redemption insert failed: ${error?.message}`);
    return data.id;
  }

  it("returns the grant fields for an unconsumed redemption", async () => {
    const orgId = await newOrg();
    const codeId = await mintCode({
      trialDays: 21,
      stripeCouponId: "coupon_test",
      planSlug: "builder",
    });
    await bindRedemption(codeId, orgId);

    const result = await getPendingAccessCodeBenefit(orgId);
    expect(result).toEqual({
      trialDays: 21,
      stripeCouponId: "coupon_test",
      planSlug: "builder",
    });
  });

  it("does NOT consume the grant — repeated reads return the same thing", async () => {
    const orgId = await newOrg();
    const codeId = await mintCode({ trialDays: 14, planSlug: null });
    const redemptionId = await bindRedemption(codeId, orgId);

    const first = await getPendingAccessCodeBenefit(orgId);
    const second = await getPendingAccessCodeBenefit(orgId);
    expect(first).toEqual(second);
    expect(first?.trialDays).toBe(14);

    const { data: row } = await db
      .from("access_code_redemptions")
      .select("benefit_consumed_at")
      .eq("id", redemptionId)
      .single();
    expect(row?.benefit_consumed_at).toBeNull();
  });

  it("returns null once the grant has actually been consumed elsewhere", async () => {
    const orgId = await newOrg();
    const codeId = await mintCode({ trialDays: 14, planSlug: null });
    const redemptionId = await bindRedemption(codeId, orgId);

    await db
      .from("access_code_redemptions")
      .update({ benefit_consumed_at: new Date().toISOString() })
      .eq("id", redemptionId);

    const result = await getPendingAccessCodeBenefit(orgId);
    expect(result).toBeNull();
  });

  it("returns null for a Team with no bound redemption", async () => {
    const orgId = await newOrg();
    const result = await getPendingAccessCodeBenefit(orgId);
    expect(result).toBeNull();
  });
});
