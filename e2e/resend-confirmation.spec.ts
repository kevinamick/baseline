import type { SupabaseClient } from "@supabase/supabase-js";
import { test, expect } from "./fixtures";
import { makeAdminClient, mailpitHasEmail, MAILPIT_API } from "./constants";
import { RESEND_CONFIRMATION_COOLDOWN_SECONDS } from "../src/lib/auth/resend-confirmation";

/**
 * e2e for the "resend confirmation email" recovery paths (#498):
 *  - the "check your email" screen's own Resend action (never arrived).
 *  - the sign-in page's expired-confirm-link banner + resend control
 *    (arrived, but the link is dead by the time it's clicked).
 *
 * Both resend surfaces show a 60s VISIBLE cooldown
 * (RESEND_CONFIRMATION_COOLDOWN_SECONDS) that mirrors prod GoTrue's own
 * `smtp_max_frequency` — the "check your email" screen's starts at mount (the
 * initial confirmation just went out), so exercising its Resend click for
 * real would mean a genuine 60s wait. Local `config.toml` sets
 * `max_frequency = "1s"` (GoTrue itself would allow an immediate resend), so
 * the only thing standing in the way is the app's own UI cooldown timer —
 * fast-forwarded here via Playwright's clock API rather than weakened.
 */

const PASSWORD = "password123";

type MailpitMessage = { ID: string; Subject: string; To: { Address: string }[] };

async function countMailpitMessages(
  subjectFragment: string,
  toAddress: string
): Promise<number> {
  const res = await fetch(`${MAILPIT_API}/api/v1/messages?limit=50`);
  if (!res.ok) return 0;
  const body = (await res.json()) as { messages?: MailpitMessage[] };
  return (body.messages ?? []).filter(
    (m) =>
      m.Subject.includes(subjectFragment) &&
      m.To.some((t) => t.Address === toAddress)
  ).length;
}

/** Best-effort lookup of an auth user's id by email for teardown (mirrors the
 *  identically-scoped helper in auth-flows.spec.ts — no shared helper yet). */
async function findUserIdByEmail(
  db: SupabaseClient,
  email: string
): Promise<string | null> {
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) return null;
  return data.users.find((u) => u.email === email)?.id ?? null;
}

test.describe("Resend confirmation email (#498)", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");
  test.describe.configure({ mode: "serial" });

  const db = makeAdminClient();

  test("check-your-email screen: Resend sends a second confirmation mail", async ({
    browser,
  }) => {
    const email = `e2e-resend-checkmail-${Date.now()}@baseline.test`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Install the virtual clock before navigating (Playwright's recommended
    // pattern) so page-load timers run naturally; only the resend control's
    // own countdown gets fast-forwarded below.
    await page.clock.install();

    await page.goto("/sign-up");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" })
    ).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(() => mailpitHasEmail("Confirm your email", email), { timeout: 30_000 })
      .toBe(true);

    // Cooldown starts at MOUNT — assert the disabled state before touching
    // the clock, so a regression that drops the cooldown entirely still fails
    // this test rather than sailing through the fast-forward below.
    const cooldownButton = page.getByRole("button", {
      name: new RegExp(`Resend available in ${RESEND_CONFIRMATION_COOLDOWN_SECONDS}s`),
    });
    await expect(cooldownButton).toBeDisabled();

    // clock.runFor (not fastForward) fires every intermediate timer, so the
    // per-second countdown's chained setTimeout calls all fire in order —
    // the same as 60 real seconds passing, without the wait.
    await page.clock.runFor(RESEND_CONFIRMATION_COOLDOWN_SECONDS * 1000);

    const resendButton = page.getByRole("button", {
      name: "Resend confirmation email",
    });
    await expect(resendButton).toBeEnabled();
    await resendButton.click();

    await expect
      .poll(() => countMailpitMessages("Confirm your email", email), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(2);

    await ctx.close();
    const userId = await findUserIdByEmail(db!, email);
    if (userId) await db!.auth.admin.deleteUser(userId);
  });

  test("expired confirm link: the focused resend state renders, resends, and the escape hatch restores sign-in", async ({
    browser,
  }) => {
    const email = `e2e-resend-expired-${Date.now()}@baseline.test`;
    // Seed a pending-unconfirmed account directly via the admin API — it
    // fires no signup-pass hook and sends no mail itself (#487/#489), so this
    // isolates "an existing unconfirmed account gets a resend" from needing a
    // real sign-up + a real hour-long expiry just to exercise the same path.
    const { data: created, error } = await db!.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: false,
    });
    if (error || !created.user) {
      throw new Error(`failed to seed e2e user: ${error?.message}`);
    }
    const userId = created.user.id;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // A fabricated token_hash fails verifyOtp regardless of which account (if
    // any) it's checked against — no real expired token is needed to exercise
    // the failure → ?error=confirm_expired path itself.
    await page.goto("/auth/confirm?token_hash=e2e-fabricated-token&type=email");
    await expect(page).toHaveURL(/\/sign-in\?error=confirm_expired/);

    // The focused single-action state (reworked per review on PR #500): the
    // card swaps entirely — tailored heading, the resend form as the one
    // primary CTA, and NO sign-in fields (Supabase refuses password sign-in
    // for unconfirmed accounts, so a password field would invite a doomed
    // attempt).
    await expect(
      page.getByRole("heading", {
        name: "That confirmation link expired or was already used",
      })
    ).toBeVisible();
    await expect(page.getByLabel("Password")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);

    // One email field (the resend form's); resending re-sends.
    await page.getByLabel("Email").fill(email);
    await page
      .getByRole("button", { name: "Resend confirmation email" })
      .click();

    await expect(
      page.getByText("If that address needs confirming, a new link is on its way.")
    ).toBeVisible();
    await expect
      .poll(() => mailpitHasEmail("Confirm your email", email), { timeout: 30_000 })
      .toBe(true);

    // The escape hatch for the already-consumed-token case (a mail-scanner
    // prefetch can confirm the account and burn the link): "Already
    // confirmed? Sign in" drops the error param and restores the normal
    // sign-in form (password field back, resend form gone).
    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Resend confirmation email" })
    ).toHaveCount(0);

    await ctx.close();
    await db!.auth.admin.deleteUser(userId);
  });
});
