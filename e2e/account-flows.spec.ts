import { test, expect, type Browser, type BrowserContext, type Page } from "./fixtures";
import type { Download } from "@playwright/test";
import { makeAdminClient, MAILPIT_API, mailpitHasEmail } from "./constants";

/**
 * Account-settings + GDPR data-subject-rights flows (#69, #74) with no prior e2e
 * coverage: display-name persistence, the email-confirmed password change,
 * the data export (right to portability), and the delete-account guardrail
 * (right to erasure).
 *
 * The spec provisions its OWN scratch user + org via the Supabase admin client
 * (mirrors `overage.spec.ts`) rather than touching any of the four seeded
 * fixtures — those are signed into by every other spec via `global-setup`, and
 * this suite mutates the account's name/password and (in the last test)
 * deletes it outright.
 *
 * Serial: later tests depend on state the earlier ones create (the new
 * password, the renamed profile), and the final test actually erases the
 * account, so nothing after it may assume the account still exists.
 */

const PASSWORD = "password123";
const NEW_PASSWORD = "new-password456";
const NEW_DISPLAY_NAME = "Scratch E2E Person";

type MailpitMessage = { ID: string; Subject: string; To: { Address: string }[] };

/**
 * Pulls the one-time reauthentication code out of the Mailpit message that
 * `changePassword`'s `intent=send-code` step triggers
 * (supabase/templates/reauthentication.html). The template renders the token
 * twice inside an identically-styled `<span>`; the first match is sufficient.
 * Callers should `expect.poll(() => mailpitHasEmail(...))` first.
 */
async function extractReauthCode(toAddress: string): Promise<string> {
  const listRes = await fetch(`${MAILPIT_API}/api/v1/messages?limit=50`);
  const listBody = (await listRes.json()) as { messages?: MailpitMessage[] };
  const message = (listBody.messages ?? []).find(
    (m) =>
      m.Subject.includes("Confirm your password change") &&
      m.To.some((t) => t.Address === toAddress)
  );
  if (!message) {
    throw new Error(`No reauthentication email found for ${toAddress}`);
  }

  const msgRes = await fetch(`${MAILPIT_API}/api/v1/message/${message.ID}`);
  const msgBody = (await msgRes.json()) as { HTML: string };
  const match = msgBody.HTML.match(
    /letter-spacing:8px;color:#0E0E10;-webkit-text-size-adjust:none;">(\w+)<\/span>/
  );
  if (!match) {
    throw new Error(`No reauthentication code found in message ${message.ID}`);
  }
  return match[1];
}

/** Reads a Playwright Download's full body as a UTF-8 string. */
async function readDownloadText(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

test.describe.configure({ mode: "serial" });

test.describe("Account settings + GDPR data rights (scratch user)", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");

  const db = makeAdminClient();
  const email = `e2e-account-${crypto.randomUUID().slice(0, 8)}@baseline.test`;
  let userId: string;
  let orgId: string;
  let storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;
  let accountDeleted = false;

  async function signInPage(browser: Browser, pw: string): Promise<Page> {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(pw);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    return page;
  }

  async function pageWithSession(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext({ storageState });
    return ctx.newPage();
  }

  test.beforeAll(async () => {
    const { data: authUser, error: authError } = await db!.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    userId = authUser.user.id;

    const { data: org, error: orgError } = await db!
      .from("organizations")
      .insert({ name: "Account Flows Spec Team" })
      .select("id")
      .single();
    if (orgError) throw new Error(orgError.message);
    orgId = org.id;

    const { error: membershipError } = await db!
      .from("memberships")
      .insert({ org_id: orgId, user_id: userId, role: "admin" });
    if (membershipError) throw new Error(membershipError.message);
  });

  test.afterAll(async () => {
    // Best-effort: the last test deletes the account itself, cascading the
    // org (the user is its sole member) — these are then no-ops. Not awaited
    // for errors, matching the established pattern (auth-flows.spec.ts).
    if (!accountDeleted) {
      if (orgId) await db!.from("organizations").delete().eq("id", orgId);
      if (userId) await db!.auth.admin.deleteUser(userId);
    }
  });

  test("changing the display name persists after reload", async ({ browser }) => {
    const page = await signInPage(browser, PASSWORD);
    storageState = await page.context().storageState();

    await page.goto("/settings/account");
    await page.getByLabel("Display name").fill(NEW_DISPLAY_NAME);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Profile saved.")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Display name")).toHaveValue(NEW_DISPLAY_NAME);

    // Refresh the captured session for later tests (unaffected by the name
    // change, but keeps this test's context authoritative going forward).
    storageState = await page.context().storageState();
    await page.context().close();
  });

  test("changing the password (email-confirmed) lets the user sign back in with it", async ({
    browser,
  }) => {
    const page = await pageWithSession(browser);
    await page.goto("/settings/account");

    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Send confirmation code" }).click();
    await expect(page.getByText("We emailed a confirmation code")).toBeVisible();

    await expect
      .poll(() => mailpitHasEmail("Confirm your password change", email), {
        timeout: 30_000,
      })
      .toBe(true);
    const code = await extractReauthCode(email);

    await page.getByLabel("Confirmation code").fill(code);
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText("Password updated.")).toBeVisible();
    await page.context().close();

    // Sign out (drop the old session) and back in with the NEW password, in a
    // fresh context — the strongest proof the change actually landed.
    const freshPage = await signInPage(browser, NEW_PASSWORD);
    storageState = await freshPage.context().storageState();
    await freshPage.context().close();
  });

  test("GDPR export downloads a JSON payload containing the user's data", async ({
    browser,
  }) => {
    const page = await pageWithSession(browser);
    await page.goto("/settings/account");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download my data" }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe(`baseline-data-export-${userId}.json`);
    const content = await readDownloadText(download);
    const payload = JSON.parse(content);

    expect(payload.auth_profile.id).toBe(userId);
    expect(payload.auth_profile.email).toBe(email);
    expect(Array.isArray(payload.memberships)).toBe(true);
    expect(payload.memberships.some((m: { org_id: string }) => m.org_id === orgId)).toBe(
      true
    );

    await page.context().close();
  });

  test("cancelling the delete-account guardrail leaves the account working", async ({
    browser,
  }) => {
    const page = await pageWithSession(browser);
    await page.goto("/settings/account");

    // Expand the danger zone; the execution button stays disabled until the
    // typed confirmation matches the account's email exactly.
    await page.getByRole("button", { name: "Delete account", exact: true }).click();
    const submit = page.getByRole("button", { name: "Delete my account" });
    await expect(submit).toBeDisabled();

    await page.locator('input[name="confirm"]').fill("not-the-right-email@example.com");
    await expect(submit).toBeDisabled();

    // "Cancel" by collapsing the accordion again without ever enabling, let
    // alone clicking, the destructive button.
    await page.getByRole("button", { name: "Delete account", exact: true }).click();
    await expect(submit).toHaveCount(0);

    // The account still works: session intact, protected pages still load.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard/);

    await page.context().close();
  });

  test("completing the delete-account flow erases the account; sign-in then fails", async ({
    browser,
  }) => {
    const page = await pageWithSession(browser);
    await page.goto("/settings/account");

    await page.getByRole("button", { name: "Delete account", exact: true }).click();
    await page.locator('input[name="confirm"]').fill(email);
    const submit = page.getByRole("button", { name: "Delete my account" });
    await expect(submit).toBeEnabled();
    await submit.click();

    // deleteAccount() redirects home on success.
    await expect(page).toHaveURL(/\/$/);
    accountDeleted = true;
    await page.context().close();

    const ctx = await browser.newContext();
    const signInPageAfterDelete = await ctx.newPage();
    await signInPageAfterDelete.goto("/sign-in");
    await signInPageAfterDelete.getByLabel("Email").fill(email);
    await signInPageAfterDelete.getByLabel("Password").fill(NEW_PASSWORD);
    await signInPageAfterDelete.getByRole("button", { name: "Sign in" }).click();
    await expect(signInPageAfterDelete.getByRole("alert")).toBeVisible();
    await expect(signInPageAfterDelete).toHaveURL(/\/sign-in/);
    await ctx.close();
  });
});
