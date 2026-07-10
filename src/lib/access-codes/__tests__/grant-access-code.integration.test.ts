import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Integration tests for the operator `grant` command (scripts/access-codes.mts):
 * retroactively binding an Access Code to an existing account. The command is a
 * CLI, so these drive it as a subprocess against the real local database — the
 * claim/insert sequencing (atomic slot claim, org-bound redemption row, the
 * duplicate-unconsumed guard protecting the checkout benefit lookup) is what's
 * under test, not printf formatting. Skipped when no local Supabase env is
 * available (CI without a DB); run locally with the .env.local vars exported:
 *
 *   set -a; source .env.local; set +a; npx vitest run grant-access-code.integration
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasDb = Boolean(url && serviceKey);

const exec = promisify(execFile);

/** Run the grant CLI; resolves with exit code + output (abort() exits 1). */
async function runGrant(
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      ["--experimental-strip-types", "scripts/access-codes.mts", "grant", ...args],
      { env: process.env, cwd: process.cwd() }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe.skipIf(!hasDb)("access-codes grant CLI (integration)", () => {
  let db: SupabaseClient;
  const codeIds: string[] = [];
  const orgIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(() => {
    db = createClient(url!, serviceKey!, { auth: { persistSession: false } });
  });

  afterAll(async () => {
    // access_code_redemptions cascade from their code; memberships from their org.
    if (codeIds.length) await db.from("access_codes").delete().in("id", codeIds);
    if (orgIds.length) await db.from("organizations").delete().in("id", orgIds);
    for (const id of userIds) await db.auth.admin.deleteUser(id);
  });

  async function mintCode(overrides: { maxRedemptions?: number } = {}) {
    const code = `GRANT-TEST-${crypto.randomUUID()}`;
    const { data, error } = await db
      .from("access_codes")
      .insert({
        code,
        max_redemptions: overrides.maxRedemptions ?? 3,
        trial_days: 14,
        stripe_coupon_id: "coupon_test_grant",
        plan_slug: "builder",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`mint fixture failed: ${error?.message}`);
    codeIds.push(data.id);
    return { id: data.id as string, code };
  }

  async function createAccount(teams: string[]) {
    const email = `grant-test-${crypto.randomUUID()}@example.com`;
    const { data, error } = await db.auth.admin.createUser({
      email,
      password: crypto.randomUUID(),
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
    userIds.push(data.user.id);

    const teamOrgIds: string[] = [];
    for (const name of teams) {
      const { data: org, error: orgError } = await db
        .from("organizations")
        .insert({ name })
        .select("id")
        .single();
      if (orgError || !org) throw new Error(`org fixture failed: ${orgError?.message}`);
      orgIds.push(org.id);
      teamOrgIds.push(org.id);
      const { error: memberError } = await db
        .from("memberships")
        .insert({ org_id: org.id, user_id: data.user.id, role: "admin" });
      if (memberError) throw new Error(`membership fixture failed: ${memberError.message}`);
    }
    return { userId: data.user.id, email, orgIds: teamOrgIds };
  }

  async function redemptionsFor(orgId: string) {
    const { data, error } = await db
      .from("access_code_redemptions")
      .select("access_code_id, user_id, org_id, benefit_consumed_at")
      .eq("org_id", orgId);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async function redeemedCount(codeId: string): Promise<number> {
    const { data, error } = await db
      .from("access_codes")
      .select("redeemed_count")
      .eq("id", codeId)
      .single();
    if (error) throw new Error(error.message);
    return data.redeemed_count;
  }

  it("binds a redemption to the user's single Team and claims a slot", async () => {
    const { id: codeId, code } = await mintCode();
    const account = await createAccount(["Grant Solo Team"]);

    // Uppercase the email to prove the lookup is case-insensitive.
    // (stderr not asserted empty — node prints a benign MODULE_TYPELESS_PACKAGE_JSON
    // warning there for every .mts script in this repo.)
    const result = await runGrant(["--code", code, "--email", account.email.toUpperCase()]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Granted access code");
    expect(result.stdout).toContain("coupon_test_grant");

    const rows = await redemptionsFor(account.orgIds[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      access_code_id: codeId,
      user_id: account.userId,
      org_id: account.orgIds[0],
      benefit_consumed_at: null, // unconsumed — the next checkout picks it up
    });
    expect(await redeemedCount(codeId)).toBe(1);
  });

  it("refuses a second unconsumed redemption for the same Team", async () => {
    const { id: codeId, code } = await mintCode();
    const account = await createAccount(["Grant Dup Team"]);

    expect((await runGrant(["--code", code, "--email", account.email])).code).toBe(0);
    const second = await runGrant(["--code", code, "--email", account.email]);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("already has an unconsumed redemption");

    // Exactly one row, and the refused attempt claimed no slot.
    expect(await redemptionsFor(account.orgIds[0])).toHaveLength(1);
    expect(await redeemedCount(codeId)).toBe(1);
  });

  it("refuses an exhausted code without inserting a redemption", async () => {
    const { id: codeId, code } = await mintCode({ maxRedemptions: 1 });
    const first = await createAccount(["Grant Cap Team A"]);
    const second = await createAccount(["Grant Cap Team B"]);

    expect((await runGrant(["--code", code, "--email", first.email])).code).toBe(0);
    const refused = await runGrant(["--code", code, "--email", second.email]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("exhausted");

    expect(await redemptionsFor(second.orgIds[0])).toHaveLength(0);
    expect(await redeemedCount(codeId)).toBe(1);
  });

  it("requires --org-id for a multi-Team user, then binds to the chosen Team", async () => {
    const { code } = await mintCode();
    const account = await createAccount(["Grant Multi One", "Grant Multi Two"]);

    const ambiguous = await runGrant(["--code", code, "--email", account.email]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain("--org-id");
    expect(ambiguous.stderr).toContain(account.orgIds[0]);
    expect(ambiguous.stderr).toContain(account.orgIds[1]);

    const chosen = await runGrant([
      "--code",
      code,
      "--email",
      account.email,
      "--org-id",
      account.orgIds[1],
    ]);
    expect(chosen.code).toBe(0);
    expect(await redemptionsFor(account.orgIds[1])).toHaveLength(1);
    expect(await redemptionsFor(account.orgIds[0])).toHaveLength(0);
  });

  it("aborts on an unknown email", async () => {
    const { code } = await mintCode();
    const result = await runGrant([
      "--code",
      code,
      "--email",
      `nobody-${crypto.randomUUID()}@example.com`,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No user with email");
  });
}, 60_000);
