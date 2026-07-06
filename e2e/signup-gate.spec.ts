import { test, expect } from "./fixtures";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeAdminClient, mailpitHasEmail, readSeed } from "./constants";
import { setSignupGateState } from "./posthog-mock";

/**
 * Full-coverage e2e for the launch-phase Access Code sign-up gate (ADR-0017,
 * #425): gated refusal, gated Invitation bypass, ungated sign-up, and the
 * fail-closed error branch. Gate state is driven entirely by a LOCAL PostHog
 * mock (e2e/posthog-mock-server.mjs) that the app's server-side flag helper
 * (src/lib/analytics/signup-gate.ts) points its own POSTHOG_HOST at — there is
 * no force-override backdoor in the helper itself; every scenario below
 * exercises the real evaluation path end to end (page render + form submit).
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
  "Baseline is invite-only right now. Enter the email your invitation was sent to and we'll get you started.";
const GATED_REFUSAL =
  "We couldn't find a pending invitation for that email. Ask your team admin to send one, or reach out to request access.";

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

  test.afterAll(async () => {
    // Reset the mock to its suite-wide default so nothing after this file
    // (there shouldn't be anything, given the project ordering, but this is
    // cheap insurance) sees a stale gated/error state.
    await setSignupGateState("off");
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

    await ctx.close();
  });
});
