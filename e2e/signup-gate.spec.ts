import { test, expect } from "./fixtures";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONTRIBUTOR_A,
  TEAM_C_NAME,
  makeAdminClient,
  mailpitHasEmail,
  readSeed,
} from "./constants";
import { setSignupGateState } from "./posthog-mock";
import { SIGNUP_PASS_REJECTION_MESSAGE } from "../src/lib/signup-passes/rejection";

/**
 * Full-coverage e2e for the launch-phase Access Code sign-up gate (ADR-0017,
 * #425 + #426): gated refusal, gated Invitation bypass, ungated sign-up, the
 * fail-closed error branch, and — #426 — the Access Code schema + atomic
 * redemption claim (valid code, exhausted code, expired code). Gate state is
 * driven entirely by a LOCAL PostHog mock (e2e/posthog-mock-server.mjs) that
 * the app's server-side flag helper (src/lib/analytics/signup-gate.ts) points
 * its own POSTHOG_HOST at — there is no force-override backdoor in the helper
 * itself; every scenario below exercises the real evaluation path end to end
 * (page render + form submit). Access Codes are minted directly against the
 * local Supabase instance the spec already has a service-role client for
 * (`db`) — the same "seed fixture inserts the row a spec needs" pattern the
 * pre-existing Invitation-bypass test below uses for `invitations`.
 *
 * Runs in its own Playwright project (see playwright.config.ts's
 * SIGNUP_GATE_SPEC), strictly after every other spec: the mock's decision is
 * process-wide and unkeyed, so any concurrent /sign-up visit from another spec
 * would race whichever state this file has set.
 */

const PASSWORD = "password123";
const MAILPIT_API = "http://127.0.0.1:54324";
const CONFIRM_LINK_RE = /href="([^"]*\/auth\/confirm\?[^"]+)"/;

const GATED_NOTICE =
  "Baseline is invite-only right now. Enter the email your invitation was sent to, or enter an access code below.";
const GATED_REFUSAL =
  "We couldn't find a pending invitation for that email. Enter an access code below, or ask your team admin to send one.";
const CODE_INVALID = "We couldn't match that access code. Double-check it and try again.";
const CODE_EXPIRED =
  "That access code has expired. Ask whoever shared it with you for a new one.";
const CODE_EXHAUSTED =
  "That access code has reached its redemption limit. Ask whoever shared it with you for a new one.";

/** Mints an Access Code row directly, returning its id for later cleanup/inspection. */
async function mintAccessCode(
  db: SupabaseClient,
  overrides: { maxRedemptions?: number; expiresAt?: string } = {},
): Promise<{ id: string; code: string }> {
  const code = `E2E-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const { data, error } = await db
    .from("access_codes")
    .insert({
      code,
      max_redemptions: overrides.maxRedemptions ?? 5,
      expires_at: overrides.expiresAt ?? null,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`failed to mint e2e access code: ${error?.message}`);
  }
  return { id: data.id as string, code };
}

/**
 * Pulls the /auth/confirm link out of the most recent Mailpit "Confirm your
 * email" message addressed to `toAddress`. Spec-local (not shared via
 * constants.ts) — mirrors the identically-scoped helper in invitations.spec.ts,
 * which notes there's no shared link-extraction helper yet.
 */
async function extractConfirmLink(toAddress: string): Promise<string> {
  const listRes = await fetch(`${MAILPIT_API}/api/v1/messages?limit=50`);
  const listBody = (await listRes.json()) as {
    messages?: { ID: string; Subject: string; To: { Address: string }[] }[];
  };
  const message = (listBody.messages ?? []).find(
    (m) =>
      m.Subject.includes("Confirm your email") &&
      m.To.some((t) => t.Address === toAddress),
  );
  if (!message) {
    throw new Error(`No confirmation email found for ${toAddress}`);
  }
  const msgRes = await fetch(`${MAILPIT_API}/api/v1/message/${message.ID}`);
  const msgBody = (await msgRes.json()) as { HTML: string };
  const match = msgBody.HTML.match(CONFIRM_LINK_RE);
  if (!match) throw new Error(`No confirm link found in message ${message.ID}`);
  return match[1].replace(/&amp;/g, "&");
}

/** Best-effort lookup of an auth user's id by email (no server-side email filter on listUsers). */
async function findUserIdByEmail(
  db: SupabaseClient,
  email: string,
): Promise<string | null> {
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) return null;
  return data.users.find((u) => u.email === email)?.id ?? null;
}

test.describe("launch-phase Access Code sign-up gate (ADR-0017, #425)", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");
  // Every test toggles the shared mock's state — serialize so they can't race.
  test.describe.configure({ mode: "serial" });

  const db = makeAdminClient()!;
  const { teamCOrgId } = readSeed();

  const createdUserIds: string[] = [];
  const createdInviteEmails: string[] = [];
  const createdAccessCodeIds: string[] = [];
  const createdOrgIds: string[] = [];

  test.afterAll(async () => {
    // Reset the mock to its suite-wide default so nothing after this file
    // (there shouldn't be anything, given the project ordering, but this is
    // cheap insurance) sees a stale gated/error state.
    await setSignupGateState("off");
    if (createdOrgIds.length > 0) {
      // Cascades memberships (and any access_code_redemptions FK is
      // on delete set null, not cascade, so the redemption row itself
      // survives its Team being cleaned up).
      await db.from("organizations").delete().in("id", createdOrgIds);
    }
    for (const id of createdUserIds) {
      await db.auth.admin.deleteUser(id).catch(() => undefined);
    }
    if (createdInviteEmails.length > 0) {
      await db
        .from("invitations")
        .delete()
        .eq("org_id", teamCOrgId)
        .in("email", createdInviteEmails);
    }
    if (createdAccessCodeIds.length > 0) {
      // access_code_redemptions cascades off access_codes.
      await db.from("access_codes").delete().in("id", createdAccessCodeIds);
    }
  });

  test("ungated: a brand-new sign-up with no invitation succeeds exactly as before", async ({
    browser,
  }) => {
    await setSignupGateState("off");
    const email = `e2e-gate-ungated-${Date.now()}@baseline.test`;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-up");
    await expect(page.getByText(GATED_NOTICE)).toHaveCount(0);

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();

    const userId = await findUserIdByEmail(db, email);
    expect(userId).not.toBeNull();
    if (userId) createdUserIds.push(userId);

    await ctx.close();
  });

  test("gated refusal: an uninvited email is refused with the invite-only message; no user is created", async ({
    browser,
  }) => {
    await setSignupGateState("on");
    const email = `e2e-gate-refused-${Date.now()}@baseline.test`;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-up");
    await expect(page.getByText(GATED_NOTICE)).toBeVisible();

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByText(GATED_REFUSAL)).toBeVisible();
    // Still on the form — refusal isn't the "check your email" terminal view.
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toHaveCount(0);

    expect(await findUserIdByEmail(db, email)).toBeNull();
    await ctx.close();
  });

  test("gated fail-closed: a PostHog evaluation error also refuses sign-up (never silently opens the gate)", async ({
    browser,
  }) => {
    await setSignupGateState("error");
    const email = `e2e-gate-error-${Date.now()}@baseline.test`;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-up");
    // The page itself fails closed too — same notice as the "on" case, since
    // isSignupGated() can't tell "flag says yes" from "couldn't read the flag".
    await expect(page.getByText(GATED_NOTICE)).toBeVisible();

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByText(GATED_REFUSAL)).toBeVisible();
    expect(await findUserIdByEmail(db, email)).toBeNull();
    await ctx.close();
  });

  test("gated Invitation bypass: a pending invitation lets its recipient sign up, confirm, and reach onboarding", async ({
    browser,
  }) => {
    await setSignupGateState("on");
    const email = `e2e-gate-invited-${Date.now()}@baseline.test`;
    createdInviteEmails.push(email);

    const { error: inviteError } = await db.from("invitations").insert({
      org_id: teamCOrgId,
      email,
      token_hash: `e2e-gate-${crypto.randomUUID()}`,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(inviteError).toBeNull();

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-up");
    await expect(page.getByText(GATED_NOTICE)).toBeVisible();

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    // The gate let this one through — no refusal, straight to the normal
    // confirmation-required view.
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();

    await expect
      .poll(() => mailpitHasEmail("Confirm your email", email), { timeout: 30_000 })
      .toBe(true);
    const confirmLink = await extractConfirmLink(email);

    await page.goto(confirmLink);
    // No org membership yet (#355 post-auth redirect) — lands on /onboarding,
    // where the pending invitation surfaces (#52), proving the bypass reaches
    // all the way through account creation.
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(
      page.getByRole("heading", { name: "You've been invited" }),
    ).toBeVisible();

    const userId = await findUserIdByEmail(db, email);
    expect(userId).not.toBeNull();
    if (userId) createdUserIds.push(userId);

    // The bypass consumes nothing (ADR-0017): no redemption row exists for
    // this brand-new user even though the gate was up.
    if (userId) {
      const { count } = await db
        .from("access_code_redemptions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);
      expect(count ?? 0).toBe(0);
    }

    await ctx.close();
  });

  test("valid access code: gated sign-up with a code creates the account and records a redemption (#426)", async ({
    browser,
  }) => {
    await setSignupGateState("on");
    const accessCode = await mintAccessCode(db, { maxRedemptions: 5 });
    createdAccessCodeIds.push(accessCode.id);
    const email = `e2e-gate-code-valid-${Date.now()}@baseline.test`;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-up");
    await expect(page.getByText(GATED_NOTICE)).toBeVisible();

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByLabel("Access code").fill(accessCode.code);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();

    await expect
      .poll(() => mailpitHasEmail("Confirm your email", email), { timeout: 30_000 })
      .toBe(true);
    const confirmLink = await extractConfirmLink(email);
    await page.goto(confirmLink);
    await expect(page).toHaveURL(/\/onboarding/);

    const userId = await findUserIdByEmail(db, email);
    expect(userId).not.toBeNull();
    if (userId) createdUserIds.push(userId);

    // Case-insensitive match: the code was minted upper-case; the redemption
    // below proves it claimed regardless (the form submitted it verbatim, so
    // this also indirectly proves the RPC lower()-compares both sides).
    const { data: redemption, error: redemptionError } = await db
      .from("access_code_redemptions")
      .select("id, user_id, access_code_id")
      .eq("access_code_id", accessCode.id)
      .maybeSingle();
    expect(redemptionError).toBeNull();
    expect(redemption?.user_id).toBe(userId);

    const { data: codeRow } = await db
      .from("access_codes")
      .select("redeemed_count")
      .eq("id", accessCode.id)
      .single();
    expect(codeRow?.redeemed_count).toBe(1);

    await ctx.close();
  });

  test("exhausted access code: a cap-1 code refuses a second redemption with the exhausted message (#426)", async ({
    browser,
  }) => {
    await setSignupGateState("on");
    const accessCode = await mintAccessCode(db, { maxRedemptions: 1 });
    createdAccessCodeIds.push(accessCode.id);

    // Consume the single slot directly via the claim RPC — equivalent to a
    // first successful sign-up, without needing a second full browser flow.
    const { data: firstClaim, error: firstClaimError } = await db.rpc(
      "claim_access_code",
      { p_code: accessCode.code },
    );
    expect(firstClaimError).toBeNull();
    const claimed = Array.isArray(firstClaim) ? firstClaim[0] : firstClaim;
    expect(claimed?.claimed).toBe(true);

    const email = `e2e-gate-code-exhausted-${Date.now()}@baseline.test`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-up");

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    // Lower-cased on submit — proves the case-insensitive match still finds
    // (and correctly refuses) the exhausted code.
    await page.getByLabel("Access code").fill(accessCode.code.toLowerCase());
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByText(CODE_EXHAUSTED)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toHaveCount(0);
    expect(await findUserIdByEmail(db, email)).toBeNull();

    await ctx.close();
  });

  test("expired access code: refuses with the expired message; no user is created (#426)", async ({
    browser,
  }) => {
    await setSignupGateState("on");
    const accessCode = await mintAccessCode(db, {
      maxRedemptions: 5,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    createdAccessCodeIds.push(accessCode.id);
    const email = `e2e-gate-code-expired-${Date.now()}@baseline.test`;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-up");

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByLabel("Access code").fill(accessCode.code);
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByText(CODE_EXPIRED)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toHaveCount(0);
    expect(await findUserIdByEmail(db, email)).toBeNull();

    // Nothing was claimed — the count stays at 0.
    const { data: codeRow } = await db
      .from("access_codes")
      .select("redeemed_count")
      .eq("id", accessCode.id)
      .single();
    expect(codeRow?.redeemed_count).toBe(0);

    await ctx.close();
  });

  test("invalid access code: an unrecognized code is refused; no user is created (#426)", async ({
    browser,
  }) => {
    await setSignupGateState("on");
    const email = `e2e-gate-code-invalid-${Date.now()}@baseline.test`;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-up");

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByLabel("Access code").fill("NOT-A-REAL-CODE");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByText(CODE_INVALID)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toHaveCount(0);
    expect(await findUserIdByEmail(db, email)).toBeNull();

    await ctx.close();
  });

  test("confirmed-duplicate email: the response is indistinguishable from a fresh sign-up AND the claim is released (#426, #489)", async ({
    browser,
  }) => {
    // A CONFIRMED existing account 422s from GoTrue before the signup-pass hook
    // (real provider behavior; the obfuscated empty-`identities`/no-error shape
    // ADR-0017 also describes is exercised at the unit level in auth.test.ts,
    // "releases the claim on the anti-enumeration existing-email path" — both
    // are the SAME "no genuine new account" branch in signUp). Per #489 the app
    // now collapses that 422 to the SAME generic "Check your email" response a
    // brand-new email returns (no mail is sent), so a confirmed account can't be
    // enumerated by the sign-up form. This test proves both halves end to end:
    // the response is indistinguishable, and the claimed slot is still released.
    await setSignupGateState("on");
    const accessCode = await mintAccessCode(db, { maxRedemptions: 1 });
    createdAccessCodeIds.push(accessCode.id);
    const email = CONTRIBUTOR_A.email; // pre-existing, confirmed seeded account

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-up");

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByLabel("Access code").fill(accessCode.code);
    await page.getByRole("button", { name: "Create account" }).click();
    // Anti-enumeration: the SAME generic success view a fresh email gets, with
    // no "already registered" error leaking that the account exists.
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: /already registered/i }),
    ).toHaveCount(0);

    // The claim was released — the slot is still available for a real
    // sign-up. Polled as belt-and-suspenders against any residual skew
    // between the rendered response and the DB read on a slow CI runner.
    await expect
      .poll(async () => {
        const { data: codeRow } = await db
          .from("access_codes")
          .select("redeemed_count")
          .eq("id", accessCode.id)
          .single();
        return codeRow?.redeemed_count;
      })
      .toBe(0);

    const { count } = await db
      .from("access_code_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("access_code_id", accessCode.id);
    expect(count ?? 0).toBe(0);

    await ctx.close();
  });

  test("first-Team binding: creating a Team after redeeming a code stamps the redemption with that Team (#427)", async ({
    browser,
  }) => {
    await setSignupGateState("on");
    const accessCode = await mintAccessCode(db, { maxRedemptions: 5 });
    createdAccessCodeIds.push(accessCode.id);
    const email = `e2e-gate-bind-team-${Date.now()}@baseline.test`;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-up");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByLabel("Access code").fill(accessCode.code);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();

    await expect
      .poll(() => mailpitHasEmail("Confirm your email", email), { timeout: 30_000 })
      .toBe(true);
    const confirmLink = await extractConfirmLink(email);
    await page.goto(confirmLink);
    await expect(page).toHaveURL(/\/onboarding/);

    const userId = await findUserIdByEmail(db, email);
    expect(userId).not.toBeNull();
    if (userId) createdUserIds.push(userId);

    // No Team yet — the redemption is recorded but unbound (org_id null).
    const { data: unbound } = await db
      .from("access_code_redemptions")
      .select("id, org_id")
      .eq("access_code_id", accessCode.id)
      .single();
    expect(unbound?.org_id).toBeNull();

    // Create their first Team through the real onboarding form. An Access Code
    // redeemer lands on /pricing after onboarding (not /rubrics) so they can
    // apply their benefit and convert (#491); the binding below is unaffected.
    await page.getByLabel("Team name").fill("E2E Bind Team");
    await page.getByRole("button", { name: "Create team" }).click();
    await expect(page).toHaveURL(/\/pricing/);

    const { data: membership } = await db
      .from("memberships")
      .select("org_id")
      .eq("user_id", userId!)
      .single();
    expect(membership?.org_id).not.toBeNull();
    if (membership?.org_id) createdOrgIds.push(membership.org_id);

    // The redemption is now stamped with the Team they just created — its
    // billing benefit binds here (ADR-0017 slice 3, #427).
    const { data: bound } = await db
      .from("access_code_redemptions")
      .select("org_id")
      .eq("id", unbound!.id)
      .single();
    expect(bound?.org_id).toBe(membership?.org_id);

    await ctx.close();
  });

  // #487/#489: the gate used to be enforceable only inside the signUp server
  // action, so POSTing straight to GoTrue's REST create endpoints with the
  // public anon key created an account with no code and no invitation. The
  // before_user_created hook (supabase/migrations/20260712000000_signup_passes.sql)
  // now rejects any self-service email creation that does not present a valid
  // app-minted pass whose NONCE matches — proven here against the REAL GoTrue
  // REST endpoints, in BOTH gate states, because the pass requirement is
  // deliberately unconditional (it survives gate-lift).
  //
  // What this proves (the honest property, #489 finding 2): the hook adds a
  // GENERIC 403 for a fresh, unregistered email hitting the raw endpoint —
  // that is what these probes assert. It does NOT claim to erase the
  // registered-vs-unregistered differential: a duplicate email still gets
  // GoTrue's own 422/resend response BEFORE the hook runs (the hook never sees
  // duplicates). That residual is GoTrue-level and pre-existing; see ADR-0017.
  for (const gateState of ["on", "off"] as const) {
    test(`direct GoTrue REST signup with the anon key is refused for a fresh email (gate ${gateState}) (#487)`, async () => {
      await setSignupGateState(gateState);
      const email = `e2e-gotrue-direct-${gateState}-${Date.now()}@baseline.test`;

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/signup`,
        {
          method: "POST",
          headers: {
            apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email, password: PASSWORD }),
        },
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { msg?: string };
      // The refusal is generic — no oracle about passes, codes, or gate state.
      expect(body.msg).toBe(SIGNUP_PASS_REJECTION_MESSAGE);
      // No usable account resulted.
      expect(await findUserIdByEmail(db, email)).toBeNull();
    });
  }

  // #489 finding 1: the pass is bound to a per-request nonce the app carries in
  // options.data, not to the email alone. A direct-REST attacker who fabricates
  // (or omits) a nonce cannot consume a pass they didn't mint — so even a
  // wrong/absent nonce is refused. Belt-and-suspenders against a would-be
  // "race the victim's pass" attacker who guesses the metadata channel.
  test("direct GoTrue REST signup with a fabricated nonce is still refused (#489 nonce binding)", async () => {
    await setSignupGateState("off");
    const email = `e2e-gotrue-nonce-${Date.now()}@baseline.test`;

    const res = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/signup`,
      {
        method: "POST",
        headers: {
          apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          "Content-Type": "application/json",
        },
        // An attacker CAN set user_metadata via /signup, but not a nonce that
        // matches a pass they never minted.
        body: JSON.stringify({
          email,
          password: PASSWORD,
          data: { signup_nonce: "attacker-fabricated-nonce" },
        }),
      },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { msg?: string };
    expect(body.msg).toBe(SIGNUP_PASS_REJECTION_MESSAGE);
    expect(await findUserIdByEmail(db, email)).toBeNull();
  });

  // #489 finding 4: email OTP / magic-link (POST /auth/v1/otp with create) is a
  // second anon create surface. Empirically the hook DOES fire for it, so an
  // OTP create with no pass is refused just like /signup — the bypass #487
  // closes stays closed for OTP too.
  test("direct GoTrue REST email-OTP create with the anon key is refused (#489 OTP path)", async () => {
    await setSignupGateState("off");
    const email = `e2e-gotrue-otp-${Date.now()}@baseline.test`;

    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/otp`, {
      method: "POST",
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, create_user: true }),
    });

    expect(res.status).toBe(403);
    expect(await findUserIdByEmail(db, email)).toBeNull();
  });

  test("invited-Team: accepting an Invitation into an existing Team transfers nothing (#427)", async ({
    browser,
  }) => {
    await setSignupGateState("on");
    const accessCode = await mintAccessCode(db, { maxRedemptions: 5 });
    createdAccessCodeIds.push(accessCode.id);
    const email = `e2e-gate-invited-team-${Date.now()}@baseline.test`;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-up");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    // Redeemed at sign-up, with NO pending Invitation yet — if one already
    // existed, the Invitation bypass would ignore the code entirely (#426),
    // and no redemption row would exist for this test to prove anything
    // about. The Invitation is created only after this account exists.
    await page.getByLabel("Access code").fill(accessCode.code);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();

    await expect
      .poll(() => mailpitHasEmail("Confirm your email", email), { timeout: 30_000 })
      .toBe(true);
    const confirmLink = await extractConfirmLink(email);
    await page.goto(confirmLink);
    await expect(page).toHaveURL(/\/onboarding/);

    const userId = await findUserIdByEmail(db, email);
    expect(userId).not.toBeNull();
    if (userId) createdUserIds.push(userId);

    createdInviteEmails.push(email);
    const { error: inviteError } = await db.from("invitations").insert({
      org_id: teamCOrgId,
      email,
      token_hash: `e2e-gate-bind-${crypto.randomUUID()}`,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(inviteError).toBeNull();

    // Re-visit onboarding now that the invite exists — it's surfaced by
    // verified email on every render, regardless of when it was created.
    await page.goto("/onboarding");
    await expect(
      page.getByRole("heading", { name: "You've been invited" }),
    ).toBeVisible();
    await page.getByRole("button", { name: `Join ${TEAM_C_NAME}` }).click();
    await expect(page).toHaveURL(/\/rubrics/);

    const { data: membership } = await db
      .from("memberships")
      .select("org_id, role")
      .eq("user_id", userId!)
      .eq("org_id", teamCOrgId)
      .single();
    expect(membership?.role).toBe("member");

    // The redemption is untouched — joining someone else's existing Team
    // via Invitation transfers nothing to it (ADR-0017).
    const { data: redemption } = await db
      .from("access_code_redemptions")
      .select("org_id")
      .eq("access_code_id", accessCode.id)
      .single();
    expect(redemption?.org_id).toBeNull();

    await ctx.close();
  });
});
