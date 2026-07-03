import type { SupabaseClient } from "@supabase/supabase-js";
import { test, expect } from "./fixtures";
import { ANON_STATE, CONTRIBUTOR_A, MAILPIT_API, makeAdminClient, mailpitHasEmail } from "./constants";

/**
 * Auth flows with no prior e2e coverage: sign-up + email confirmation into
 * first-run onboarding (#354, #355), forgot/reset password, and the
 * authenticated-user guard on the public auth pages (#356). `e2e/auth.spec.ts`
 * already covers signed-out route gating and the sign-in form itself — this
 * file is additive, not a rewrite.
 *
 * Mailpit (http://127.0.0.1:54324) is the e2e stack's email sink. `constants.ts`
 * exports `mailpitHasEmail` for polling "has the email arrived yet"; extracting
 * the actual confirm/recovery link out of a message body is spec-local (below),
 * since no shared helper for that exists yet.
 */

const PASSWORD = "password123";

type MailpitMessage = { ID: string; Subject: string; To: { Address: string }[] };

/**
 * Finds the most recent Mailpit message matching `subjectFragment` addressed to
 * `toAddress`, fetches its full body, and pulls the first `/auth/confirm?...`
 * link out of the HTML. Both the confirmation and recovery templates
 * (supabase/templates/{confirmation,recovery}.html) render this link twice
 * (a button + a plain-text fallback) with an identical href, so grabbing the
 * first match is sufficient. Callers should `expect.poll(() =>
 * mailpitHasEmail(...))` first so this only runs once the message exists.
 */
async function extractConfirmLink(
  toAddress: string,
  subjectFragment: string
): Promise<string> {
  const listRes = await fetch(`${MAILPIT_API}/api/v1/messages?limit=50`);
  const listBody = (await listRes.json()) as { messages?: MailpitMessage[] };
  const message = (listBody.messages ?? []).find(
    (m) =>
      m.Subject.includes(subjectFragment) &&
      m.To.some((t) => t.Address === toAddress)
  );
  if (!message) {
    throw new Error(
      `No Mailpit message found for ${toAddress} matching "${subjectFragment}"`
    );
  }

  const msgRes = await fetch(`${MAILPIT_API}/api/v1/message/${message.ID}`);
  const msgBody = (await msgRes.json()) as { HTML: string };
  const match = msgBody.HTML.match(/href="([^"]*\/auth\/confirm\?[^"]+)"/);
  if (!match) {
    throw new Error(`No /auth/confirm link found in message ${message.ID}`);
  }
  // The template HTML-escapes the `&` between query params.
  return match[1].replace(/&amp;/g, "&");
}

/**
 * Best-effort lookup of an auth user's id by email for teardown. The installed
 * @supabase/supabase-js admin API has no server-side email filter on
 * `listUsers`, so this pages through (a generous single page covers every
 * local/CI e2e run) and filters client-side.
 */
async function findUserIdByEmail(
  db: SupabaseClient,
  email: string
): Promise<string | null> {
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) return null;
  return data.users.find((u) => u.email === email)?.id ?? null;
}

test.describe("Sign-up, email confirmation, and first-run onboarding (#354, #355)", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");
  test.describe.configure({ mode: "serial" });

  const db = makeAdminClient();
  const email = `e2e-signup-${Date.now()}@baseline.test`;
  let userId: string | null = null;
  let orgId: string | null = null;

  test.afterAll(async () => {
    // Best-effort, self-cleaning teardown so repeat runs (local or CI) don't
    // accumulate scratch users/orgs. The org delete cascades the membership
    // the create-team step creates.
    if (orgId) await db!.from("organizations").delete().eq("id", orgId);
    if (userId) await db!.auth.admin.deleteUser(userId);
  });

  test("the confirmation link authenticates on first navigation and lands on /onboarding", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto("/sign-up");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    // Form submissions here run a server action that round-trips Supabase auth
    // (and sends mail); allow more than the 10s default before the UI settles.
    await expect(
      page.getByRole("heading", { name: "Check your email" })
    ).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(() => mailpitHasEmail("Confirm your email", email), { timeout: 30_000 })
      .toBe(true);
    const link = await extractConfirmLink(email, "Confirm your email");

    // This is the ONLY navigation to the confirm link. If the #354 cookie-bridge
    // fix regressed, the session cookie wouldn't have landed yet and this first
    // load would still look signed-out (stuck on /sign-in or bounced back to it)
    // instead of authenticating straight through to onboarding.
    await page.goto(link);
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 20_000 });

    userId = await findUserIdByEmail(db!, email);
    expect(userId).not.toBeNull();

    await ctx.close();
  });

  test("creating a team from /onboarding lands on /rubrics", async ({ browser }) => {
    expect(userId).not.toBeNull();

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    // No org yet — sign-in itself routes through the onboarding redirect (#355).
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 20_000 });

    await page.getByLabel("Team name").fill("E2E Signup Team");
    await page.getByRole("button", { name: "Create team" }).click();
    await expect(page).toHaveURL(/\/rubrics/, { timeout: 20_000 });

    const { data: membership } = await db!
      .from("memberships")
      .select("org_id")
      .eq("user_id", userId!)
      .single();
    orgId = membership?.org_id ?? null;
    expect(orgId).not.toBeNull();

    await ctx.close();
  });
});

test.describe("Forgot / reset password", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");
  test.describe.configure({ mode: "serial" });

  const db = makeAdminClient();
  const email = `e2e-reset-${Date.now()}@baseline.test`;
  const NEW_PASSWORD = "new-password456";
  let userId: string;

  test.beforeAll(async () => {
    const { data, error } = await db!.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error(error.message);
    userId = data.user.id;
  });

  test.afterAll(async () => {
    if (userId) await db!.auth.admin.deleteUser(userId);
  });

  test("the recovery link lands on /reset-password, exempt from the onboarding redirect", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" })
    ).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(() => mailpitHasEmail("Reset your password", email), { timeout: 30_000 })
      .toBe(true);
    const link = await extractConfirmLink(email, "Reset your password");

    await page.goto(link);
    // This user has no org, but recovery keeps its `next=/reset-password`
    // untouched by resolveOnboardingRedirect (#355 exemption) rather than
    // bouncing to /onboarding.
    await expect(page).toHaveURL(/\/reset-password/, { timeout: 20_000 });

    // exact: true — "Confirm new password" also substring-matches "New password".
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Update password" }).click();
    // resetPassword redirects to /dashboard; its own no-org backstop then sends
    // this (org-less) scratch user on to /onboarding. Either way it must be OFF
    // /reset-password and /sign-in with no error.
    await expect(page).toHaveURL(/\/(dashboard|onboarding)/, { timeout: 20_000 });

    await ctx.close();
  });

  test("signing in with the new password succeeds", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 20_000 });

    await ctx.close();
  });
});

test.describe("Authenticated-user guard (#356)", () => {
  test.use({ storageState: CONTRIBUTOR_A.storageState });

  for (const path of ["/sign-in", "/sign-up", "/forgot-password"]) {
    test(`visiting ${path} while signed in redirects to /dashboard`, async ({
      page,
    }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/dashboard/);
    });
  }

  test("root (/) does not redirect a signed-in visitor", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
  });
});

// Kept for symmetry with auth.spec.ts's ANON_STATE usage — not otherwise used
// in this file, but documents that the suites above intentionally use fresh
// (anonymous-by-default) contexts rather than ANON_STATE for their signed-out
// steps, since they need to carry a session forward within the same test.
void ANON_STATE;
