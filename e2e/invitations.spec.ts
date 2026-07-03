import { test, expect } from "./fixtures";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONTRIBUTOR_C,
  READONLY_A,
  TEAM_C_NAME,
  MAILPIT_API,
  makeAdminClient,
  mailpitHasEmail,
  readSeed,
} from "./constants";

/**
 * Full invitation lifecycle (#52): invite, accept-as-new-user, and revoke.
 * `billing.spec.ts`'s "seat cap at the source (#182)" describe only covers the
 * Free-plan refusal — this file is additive, covering the happy paths that
 * actually move data through `invitations` + `memberships`.
 *
 * Uses Team C ("Initech Data (seed)") because it's the seeded PAID (Builder)
 * fixture: the invite form is frozen with upgrade language on the Free plan
 * (#344, see CONTRIBUTOR_A in billing.spec.ts), so Team A can't drive this flow.
 *
 * Mailpit (http://127.0.0.1:54324) is the e2e stack's email sink. `constants.ts`
 * exports `mailpitHasEmail` for polling "has the email arrived yet"; pulling the
 * actual accept/confirm link out of a message body is spec-local (mirrors the
 * `extractConfirmLink` helper in `auth-flows.spec.ts` — no shared link-extraction
 * helper exists yet, and constants.ts is not the place to add one for this).
 */

const PASSWORD = "password123";
const INVITE_SUBJECT = "You've been invited";
const ACCEPT_LINK_RE = /href="([^"]*\/invite\/accept\?[^"]+)"/;
const CONFIRM_LINK_RE = /href="([^"]*\/auth\/confirm\?[^"]+)"/;

type MailpitMessage = { ID: string; Subject: string; To: { Address: string }[] };

/**
 * Finds the most recent Mailpit message matching `subjectFragment` addressed to
 * `toAddress`, fetches its full body, and pulls the first link matching
 * `hrefPattern` out of the HTML. Callers should `expect.poll(() =>
 * mailpitHasEmail(...))` first so this only runs once the message exists.
 */
async function extractLink(
  toAddress: string,
  subjectFragment: string,
  hrefPattern: RegExp,
): Promise<string> {
  const listRes = await fetch(`${MAILPIT_API}/api/v1/messages?limit=50`);
  const listBody = (await listRes.json()) as { messages?: MailpitMessage[] };
  const message = (listBody.messages ?? []).find(
    (m) =>
      m.Subject.includes(subjectFragment) &&
      m.To.some((t) => t.Address === toAddress),
  );
  if (!message) {
    throw new Error(
      `No Mailpit message found for ${toAddress} matching "${subjectFragment}"`,
    );
  }

  const msgRes = await fetch(`${MAILPIT_API}/api/v1/message/${message.ID}`);
  const msgBody = (await msgRes.json()) as { HTML: string };
  const match = msgBody.HTML.match(hrefPattern);
  if (!match) {
    throw new Error(`No link matching ${hrefPattern} found in message ${message.ID}`);
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
  email: string,
): Promise<string | null> {
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) return null;
  return data.users.find((u) => u.email === email)?.id ?? null;
}

test.describe("invitation lifecycle on Team C (#52)", () => {
  test.skip(!makeAdminClient(), "needs the local Supabase env");
  // The accept-as-new-user test depends on state (the invitation, the Mailpit
  // message) created by the invite test, and the revoke test shares the same
  // Team C admin session/table — serialize the whole file rather than fight
  // `fullyParallel` races over the same org's invitations.
  test.describe.configure({ mode: "serial" });

  const db = makeAdminClient();
  const { teamCOrgId } = readSeed();

  const happyEmail = `e2e-invite-happy-${Date.now()}@baseline.test`;
  const revokeEmail = `e2e-invite-revoke-${Date.now()}@baseline.test`;

  let happyUserId: string | null = null;
  // Read the live org name rather than trusting the `TEAM_C_NAME` constant
  // verbatim: it's otherwise unused by any spec today, and a local seed run
  // predating a display-name tweak would silently drift from it.
  let teamCName = TEAM_C_NAME;

  test.beforeAll(async () => {
    if (!db) return;
    const { data } = await db
      .from("organizations")
      .select("name")
      .eq("id", teamCOrgId)
      .maybeSingle();
    if (data?.name) teamCName = data.name;
  });

  test.afterAll(async () => {
    // Best-effort, self-cleaning teardown so repeat runs don't leave Team C
    // with extra members or stray invitation rows behind (other specs, e.g.
    // billing.spec.ts's seat-wall test, assume a known Team C membership).
    if (!db) return;
    if (happyUserId) {
      await db
        .from("memberships")
        .delete()
        .eq("org_id", teamCOrgId)
        .eq("user_id", happyUserId);
      await db.auth.admin.deleteUser(happyUserId);
    }
    await db
      .from("invitations")
      .delete()
      .eq("org_id", teamCOrgId)
      .in("email", [happyEmail, revokeEmail]);
  });

  test("an admin invites a new teammate; the pending invite appears and the email lands in Mailpit", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ storageState: CONTRIBUTOR_C.storageState });
    const page = await ctx.newPage();
    await page.goto("/settings/team");
    await expect(page.getByRole("heading", { name: teamCName })).toBeVisible();

    await page.getByLabel("Invite by email").fill(happyEmail);
    await page.getByRole("button", { name: "Send invite" }).click();
    await expect(page.getByText(`Invitation sent to ${happyEmail}.`)).toBeVisible();

    // The pending invitations list picks up the new invite (server action
    // revalidates /settings/team).
    await expect(
      page.getByRole("heading", { name: "Pending invitations" }),
    ).toBeVisible();
    // Exact match: the success status line above also contains this address
    // as a substring ("Invitation sent to ...").
    await expect(page.getByText(happyEmail, { exact: true })).toBeVisible();

    await expect
      .poll(() => mailpitHasEmail(INVITE_SUBJECT, happyEmail), { timeout: 30_000 })
      .toBe(true);

    const { data: invite } = await db!
      .from("invitations")
      .select("id")
      .eq("org_id", teamCOrgId)
      .eq("email", happyEmail)
      .is("accepted_at", null)
      .maybeSingle();
    expect(invite).not.toBeNull();

    await ctx.close();
  });

  test("a brand-new invitee signs up, confirms their email, and lands in Team C", async ({
    browser,
  }) => {
    const acceptLink = await extractLink(happyEmail, INVITE_SUBJECT, ACCEPT_LINK_RE);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Signed out — the accept page guides an unrecognized email to sign up
    // (src/app/[locale]/invite/accept/page.tsx: no session branch).
    await page.goto(acceptLink);
    await expect(
      page.getByRole("heading", { name: `You've been invited to ${teamCName}` }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Create an account" }).click();
    await expect(page).toHaveURL(/\/sign-up/);

    await page.getByLabel("Email").fill(happyEmail);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();

    await expect
      .poll(() => mailpitHasEmail("Confirm your email", happyEmail), { timeout: 30_000 })
      .toBe(true);
    const confirmLink = await extractLink(
      happyEmail,
      "Confirm your email",
      CONFIRM_LINK_RE,
    );

    // A new invitee signs up plainly (no fragile token-threading through the
    // confirmation email, per src/app/actions/invitations.ts) — after confirming,
    // the no-org user lands on /onboarding, where the pending invite is
    // surfaced by verified email.
    await page.goto(confirmLink);
    await expect(page).toHaveURL(/\/onboarding/);

    happyUserId = await findUserIdByEmail(db!, happyEmail);
    expect(happyUserId).not.toBeNull();

    await expect(
      page.getByRole("heading", { name: "You've been invited" }),
    ).toBeVisible();
    await page.getByRole("button", { name: `Join ${teamCName}` }).click();
    await expect(page).toHaveURL(/\/rubrics/);

    const { data: membership } = await db!
      .from("memberships")
      .select("role")
      .eq("org_id", teamCOrgId)
      .eq("user_id", happyUserId!)
      .maybeSingle();
    expect(membership?.role).toBe("member");

    await ctx.close();
  });

  test("an admin revokes a pending invite; it disappears and its accept link stops working", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ storageState: CONTRIBUTOR_C.storageState });
    const page = await ctx.newPage();
    await page.goto("/settings/team");

    await page.getByLabel("Invite by email").fill(revokeEmail);
    await page.getByRole("button", { name: "Send invite" }).click();
    await expect(page.getByText(`Invitation sent to ${revokeEmail}.`)).toBeVisible();
    await expect(page.getByText(revokeEmail, { exact: true })).toBeVisible();

    await expect
      .poll(() => mailpitHasEmail(INVITE_SUBJECT, revokeEmail), { timeout: 30_000 })
      .toBe(true);
    const acceptLink = await extractLink(revokeEmail, INVITE_SUBJECT, ACCEPT_LINK_RE);

    const inviteRow = page.locator("li", { hasText: revokeEmail });
    await inviteRow.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText(revokeEmail, { exact: true })).toHaveCount(0);

    const { data: invite } = await db!
      .from("invitations")
      .select("id")
      .eq("org_id", teamCOrgId)
      .eq("email", revokeEmail)
      .maybeSingle();
    expect(invite).toBeNull();

    // `revokeInvitation` hard-deletes the row, so the accept page's lookup by
    // token_hash comes back empty rather than "already used".
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(acceptLink);
    await expect(
      page2.getByRole("heading", { name: "Invitation not found" }),
    ).toBeVisible();
    await ctx2.close();

    await ctx.close();
  });
});

test.describe("team settings: readonly gating", () => {
  test.use({ storageState: READONLY_A.storageState });

  test("a readonly member is bounced off /settings/team and never sees the invite form", async ({
    page,
  }) => {
    // Only the org admin (Contributor) manages the team (page.tsx: `if
    // (!canWrite || !orgId) redirect("/rubrics")`) — a readonly Member never
    // reaches the page the invite form lives on.
    await page.goto("/settings/team");
    await expect(page).toHaveURL(/\/rubrics/);
    await expect(page.getByLabel("Invite by email")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Send invite" }),
    ).toHaveCount(0);
  });
});
