import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

/**
 * Integration tests for the one-shot checkout benefit evaluation (ADR-0017
 * slice 3, #427) against the real local database — the one-shot guarantee is
 * a guarded UPDATE living in Postgres, so it's proven here rather than
 * mocked, the same rationale as claim-access-code.integration.test.ts.
 * Skipped when no local Supabase env is available (CI without a DB); run
 * locally with the .env.local vars exported:
 *
 *   set -a; source .env.local; set +a; npx vitest run checkout-benefit.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

type EvalFn = (typeof import("../checkout-benefit"))["evaluateAndConsumeAccessCodeBenefit"];

describe.skipIf(!hasDb)("evaluateAndConsumeAccessCodeBenefit (integration)", () => {
  let db: SupabaseClient;
  let evaluateAndConsumeAccessCodeBenefit: EvalFn;
  const createdOrgIds: string[] = [];
  const createdCodeIds: string[] = [];

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    // The module reads real env at import time (createClient at module
    // load) — import dynamically after confirming a DB is present, mirroring
    // claim-gate.integration.test.ts's guard against the no-DB CI job.
    ({ evaluateAndConsumeAccessCodeBenefit } = await import("../checkout-benefit"));
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
      .insert({ name: "427 checkout-benefit org" })
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
    // "trialDays" in overrides (not `?? 14`): an explicit `trialDays: null`
    // must mint a coupon-only code with NO trial, distinct from simply
    // omitting the option (which still defaults to 14 for the pre-existing
    // trial-only tests above).
    const trialDays = "trialDays" in overrides ? overrides.trialDays : 14;
    const { data, error } = await db
      .from("access_codes")
      .insert({
        code,
        max_redemptions: 5,
        trial_days: trialDays,
        stripe_coupon_id: overrides.stripeCouponId ?? null,
        plan_slug: overrides.planSlug ?? null,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`mint failed: ${error?.message}`);
    createdCodeIds.push(data.id);
    return data.id;
  }

  async function bindRedemption(
    accessCodeId: string,
    orgId: string
  ): Promise<string> {
    // A real user row is required by the FK; reuse an existing seed-free
    // approach — insert a bare auth user via a fixed placeholder is overkill
    // here since access_code_redemptions.user_id only needs to reference
    // SOME users row for the FK. Create a minimal one via auth admin.
    const { data: authUser, error: authErr } = await db.auth.admin.createUser({
      email: `checkout-benefit-${crypto.randomUUID()}@example.com`,
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

  it("applies the trial once and consumes the redemption so it never applies again", async () => {
    const orgId = await newOrg();
    const codeId = await mintCode({ trialDays: 21, planSlug: null });
    const redemptionId = await bindRedemption(codeId, orgId);

    const first = await evaluateAndConsumeAccessCodeBenefit(orgId, "builder");
    expect(first).toEqual({ trialPeriodDays: 21, stripeCouponId: null });

    const { data: row } = await db
      .from("access_code_redemptions")
      .select("benefit_consumed_at")
      .eq("id", redemptionId)
      .single();
    expect(row?.benefit_consumed_at).not.toBeNull();

    // Churn-and-resubscribe: a second checkout for the SAME Team gets nothing.
    const second = await evaluateAndConsumeAccessCodeBenefit(orgId, "builder");
    expect(second).toEqual({ trialPeriodDays: null, stripeCouponId: null });
  });

  it("does not apply the trial on a plan-restriction mismatch, but still consumes it", async () => {
    const orgId = await newOrg();
    const codeId = await mintCode({ trialDays: 14, planSlug: "scale" });
    const redemptionId = await bindRedemption(codeId, orgId);

    const result = await evaluateAndConsumeAccessCodeBenefit(orgId, "builder");
    expect(result).toEqual({ trialPeriodDays: null, stripeCouponId: null });

    const { data: row } = await db
      .from("access_code_redemptions")
      .select("benefit_consumed_at")
      .eq("id", redemptionId)
      .single();
    expect(row?.benefit_consumed_at).not.toBeNull();
  });

  it("returns no benefit for a Team with no bound redemption", async () => {
    const orgId = await newOrg();
    const result = await evaluateAndConsumeAccessCodeBenefit(orgId, "builder");
    expect(result).toEqual({ trialPeriodDays: null, stripeCouponId: null });
  });

  it("never over-applies the grant under concurrent checkout attempts for the same Team", async () => {
    const orgId = await newOrg();
    const codeId = await mintCode({ trialDays: 10, planSlug: null });
    await bindRedemption(codeId, orgId);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        evaluateAndConsumeAccessCodeBenefit(orgId, "builder")
      )
    );
    const granted = results.filter((r) => r.trialPeriodDays != null);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toEqual({ trialPeriodDays: 10, stripeCouponId: null });
  });

  describe("Stripe coupon grant (#428)", () => {
    it("applies a trial and a coupon together on one checkout", async () => {
      const orgId = await newOrg();
      const codeId = await mintCode({
        trialDays: 14,
        stripeCouponId: "coupon_launch50",
        planSlug: null,
      });
      await bindRedemption(codeId, orgId);

      const result = await evaluateAndConsumeAccessCodeBenefit(orgId, "builder");
      expect(result).toEqual({
        trialPeriodDays: 14,
        stripeCouponId: "coupon_launch50",
      });
    });

    it("forfeits both the trial and the coupon on a plan-restriction mismatch", async () => {
      const orgId = await newOrg();
      const codeId = await mintCode({
        trialDays: 14,
        stripeCouponId: "coupon_launch50",
        planSlug: "scale",
      });
      const redemptionId = await bindRedemption(codeId, orgId);

      const result = await evaluateAndConsumeAccessCodeBenefit(orgId, "builder");
      expect(result).toEqual({ trialPeriodDays: null, stripeCouponId: null });

      const { data: row } = await db
        .from("access_code_redemptions")
        .select("benefit_consumed_at")
        .eq("id", redemptionId)
        .single();
      expect(row?.benefit_consumed_at).not.toBeNull();
    });

    it("applies the coupon on a matching-plan checkout after a mismatched plan would have forfeited it", async () => {
      const orgId = await newOrg();
      const codeId = await mintCode({
        trialDays: null,
        stripeCouponId: "coupon_builder_only",
        planSlug: "builder",
      });
      await bindRedemption(codeId, orgId);

      // Consuming happens on the FIRST checkout attempt, whichever plan it's
      // for — this proves a matching-plan checkout (not a prior mismatched
      // attempt) applies the grant, mirroring the pricing page's warning
      // flow where the mismatch dialog is only ever shown, never submitted.
      const result = await evaluateAndConsumeAccessCodeBenefit(orgId, "builder");
      expect(result).toEqual({
        trialPeriodDays: null,
        stripeCouponId: "coupon_builder_only",
      });
    });
  });
});
