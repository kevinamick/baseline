import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

/**
 * Integration tests for the first-Team Access Code binding (ADR-0017 slice 3,
 * #427) against the real local database — the "second Team gets nothing"
 * guarantee is a guarded UPDATE living in Postgres (`org_id IS NULL`), so
 * it's proven here by calling the real function twice, the same rationale as
 * claim-access-code.integration.test.ts. There is currently no UI path to
 * create a SECOND Team (the /onboarding create-team form only ever renders
 * for an orgless user, and an existing-Team user is redirected away before
 * reaching it — see AGENTS.md's onboarding section), so this integration
 * test is the substantive proof of that half of the acceptance criteria; the
 * e2e suite (signup-gate.spec.ts) proves the first-Team + invited-Team paths
 * through the real UI. Skipped without a local Supabase env:
 *
 *   set -a; source .env.local; set +a; npx vitest run first-team-binding.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

type BindFn = (typeof import("../first-team-binding"))["bindFirstTeamAccessCodeRedemption"];

describe.skipIf(!hasDb)("bindFirstTeamAccessCodeRedemption (integration)", () => {
  let db: SupabaseClient;
  let bindFirstTeamAccessCodeRedemption: BindFn;
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdCodeIds: string[] = [];

  beforeAll(async () => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    ({ bindFirstTeamAccessCodeRedemption } = await import(
      "../first-team-binding"
    ));
  });

  afterAll(async () => {
    if (createdOrgIds.length > 0) {
      await db.from("organizations").delete().in("id", createdOrgIds);
    }
    for (const id of createdUserIds) {
      await db.auth.admin.deleteUser(id).catch(() => undefined);
    }
    if (createdCodeIds.length > 0) {
      // access_code_redemptions cascades off access_codes.
      await db.from("access_codes").delete().in("id", createdCodeIds);
    }
  });

  async function newUser(): Promise<string> {
    const { data, error } = await db.auth.admin.createUser({
      email: `first-team-binding-${crypto.randomUUID()}@example.com`,
      password: crypto.randomUUID(),
      email_confirm: true,
    });
    if (error) throw new Error(error.message);
    const userId = data.user.id;
    createdUserIds.push(userId);
    await db.from("users").upsert({ id: userId }, { onConflict: "id" });
    return userId;
  }

  async function newOrg(): Promise<string> {
    const { data, error } = await db
      .from("organizations")
      .insert({ name: "427 first-team-binding org" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`org insert failed: ${error?.message}`);
    createdOrgIds.push(data.id);
    return data.id;
  }

  async function newRedemption(userId: string): Promise<string> {
    const code = `TEST-${crypto.randomUUID()}`;
    const { data: codeRow, error: codeErr } = await db
      .from("access_codes")
      .insert({ code, max_redemptions: 5 })
      .select("id")
      .single();
    if (codeErr || !codeRow) throw new Error(`mint failed: ${codeErr?.message}`);
    createdCodeIds.push(codeRow.id);

    const { data, error } = await db
      .from("access_code_redemptions")
      .insert({ access_code_id: codeRow.id, user_id: userId })
      .select("id")
      .single();
    if (error || !data) throw new Error(`redemption insert failed: ${error?.message}`);
    return data.id;
  }

  it("stamps the redeemer's unbound redemption with their first Team", async () => {
    const userId = await newUser();
    const redemptionId = await newRedemption(userId);
    const orgId = await newOrg();

    await bindFirstTeamAccessCodeRedemption(userId, orgId);

    const { data: row } = await db
      .from("access_code_redemptions")
      .select("org_id")
      .eq("id", redemptionId)
      .single();
    expect(row?.org_id).toBe(orgId);
  });

  it("leaves the redemption bound to the FIRST Team when the same user creates a second Team", async () => {
    const userId = await newUser();
    const redemptionId = await newRedemption(userId);
    const firstOrgId = await newOrg();
    const secondOrgId = await newOrg();

    await bindFirstTeamAccessCodeRedemption(userId, firstOrgId);
    await bindFirstTeamAccessCodeRedemption(userId, secondOrgId);

    const { data: row } = await db
      .from("access_code_redemptions")
      .select("org_id")
      .eq("id", redemptionId)
      .single();
    expect(row?.org_id).toBe(firstOrgId);
    expect(row?.org_id).not.toBe(secondOrgId);
  });

  it("is a no-op for a user with no redemption at all", async () => {
    const userId = await newUser();
    const orgId = await newOrg();

    await expect(
      bindFirstTeamAccessCodeRedemption(userId, orgId)
    ).resolves.toBeUndefined();
  });
});
