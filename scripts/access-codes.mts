/**
 * Operator-only Access Code mint + redemption read-back (ADR-0017, #426).
 * ─────────────────────────────────────────────────────────────────────────
 * Minting is script-only by design (ADR-0017): there is no admin UI, and the
 * Stripe Dashboard remains the coupon UI. This is the one place a code is
 * created — everything else (the sign-up form's atomic claim, redemption
 * attribution) reads what this script writes.
 *
 * Talks directly to whichever Supabase project NEXT_PUBLIC_SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY point at (local .env.local, staging, or prod) —
 * same service-role access pattern as scripts/seed-e2e.mjs, but with NO
 * "never production" guard: minting a real launch code against prod is this
 * script's actual job, not a mistake to block.
 *
 * Usage (see the `mint`/`status` npm scripts):
 *
 *   npm run access-codes:mint -- --code LAUNCH2026 --max-redemptions 50 \
 *     [--expires-at 2026-12-31T00:00:00Z] [--trial-days 14] \
 *     [--stripe-coupon-id coupon_abc] [--plan-slug builder]
 *
 *   npm run access-codes:status -- --code LAUNCH2026
 *
 *   npm run access-codes:grant -- --code LAUNCH2026 --email user@example.com \
 *     [--org-id <uuid>]
 *
 * `grant` retroactively binds a code to an EXISTING account (sign-up already
 * happened, so the sign-up-time claim never ran): it claims a redemption slot
 * via the same atomic claim_access_code RPC the sign-up form uses (cap/expiry
 * enforced, redeemed_count stays honest) and inserts the redemption row
 * already bound to the user's Team. From there the shipped checkout-benefit
 * path (src/lib/access-codes/checkout-benefit.ts) takes over: the code's
 * trial/coupon grant applies at that Team's next checkout, exactly as if the
 * user had signed up with the code. --org-id is only needed when the user
 * belongs to more than one Team.
 *
 * --stripe-coupon-id (ADR-0017 slice 4, #428): create the coupon in the
 * Stripe Dashboard FIRST, then pass its id here — Baseline only stores the
 * reference and applies it via checkout `discounts`; it never computes or
 * mirrors the percent/amount, duration, or proration (Stripe owns that,
 * ADR-0008's mirror discipline). Belt-and-braces: the SAME coupon can also
 * carry Stripe `applies_to` product scoping (set on the coupon itself, in
 * the Dashboard) to restrict which price(s) it discounts — independent of,
 * and stackable with, this script's own --plan-slug restriction (which only
 * gates whether Baseline evaluates the grant at all).
 */
import { createClient } from "@supabase/supabase-js";
import { PLAN_SLUGS } from "../src/lib/billing/plans.ts";

function abort(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** Minimal `--flag value` / `--flag=value` parser — no CLI-arg dependency for a
 *  handful of options, matching this repo's other one-off scripts. */
function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }
  return flags;
}

function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    abort("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.");
  }
  return createClient(url!, serviceKey!, { auth: { persistSession: false } });
}

async function mint(flags: Record<string, string>) {
  const code = flags.code?.trim();
  if (!code) abort("--code is required (e.g. --code LAUNCH2026)");

  const maxRedemptionsRaw = flags["max-redemptions"];
  if (!maxRedemptionsRaw) abort("--max-redemptions is required (e.g. --max-redemptions 50)");
  const maxRedemptions = Number(maxRedemptionsRaw);
  if (!Number.isInteger(maxRedemptions) || maxRedemptions <= 0) {
    abort(`--max-redemptions must be a positive integer, got ${maxRedemptionsRaw}`);
  }

  let trialDays: number | null = null;
  if (flags["trial-days"] !== undefined) {
    trialDays = Number(flags["trial-days"]);
    if (!Number.isInteger(trialDays) || trialDays <= 0) {
      abort(`--trial-days must be a positive integer, got ${flags["trial-days"]}`);
    }
  }

  let planSlug: string | null = null;
  if (flags["plan-slug"] !== undefined) {
    planSlug = flags["plan-slug"];
    if (!(PLAN_SLUGS as readonly string[]).includes(planSlug)) {
      abort(`--plan-slug must be one of: ${PLAN_SLUGS.join(", ")} (got ${planSlug})`);
    }
  }

  let expiresAt: string | null = null;
  if (flags["expires-at"] !== undefined) {
    const parsed = new Date(flags["expires-at"]);
    if (Number.isNaN(parsed.getTime())) {
      abort(`--expires-at must be a valid ISO timestamp, got ${flags["expires-at"]}`);
    }
    expiresAt = parsed.toISOString();
  }

  const db = client();
  const { data, error } = await db
    .from("access_codes")
    .insert({
      code,
      max_redemptions: maxRedemptions,
      expires_at: expiresAt,
      trial_days: trialDays,
      stripe_coupon_id: flags["stripe-coupon-id"] ?? null,
      plan_slug: planSlug,
    })
    .select("id, code, max_redemptions, expires_at, trial_days, stripe_coupon_id, plan_slug")
    .single();

  if (error || !data) {
    abort(`Mint failed: ${error?.message ?? "no row returned"}`);
  }

  console.log(`\n✓ Minted access code\n`);
  console.log(`  id:               ${data!.id}`);
  console.log(`  code:             ${data!.code}`);
  console.log(`  max_redemptions:  ${data!.max_redemptions}`);
  console.log(`  expires_at:       ${data!.expires_at ?? "(never)"}`);
  console.log(`  trial_days:       ${data!.trial_days ?? "(none)"}`);
  console.log(`  stripe_coupon_id: ${data!.stripe_coupon_id ?? "(none)"}`);
  console.log(`  plan_slug:        ${data!.plan_slug ?? "(any plan)"}`);
  console.log("");
}

async function status(flags: Record<string, string>) {
  const code = flags.code?.trim();
  if (!code) abort("--code is required (e.g. --code LAUNCH2026)");

  const db = client();
  const { data, error } = await db
    .from("access_codes")
    .select("id, code, max_redemptions, redeemed_count, expires_at, created_at")
    .ilike("code", code)
    .maybeSingle();

  if (error) abort(`Lookup failed: ${error.message}`);
  if (!data) abort(`No access code matching "${code}" was found.`);

  const expired = data.expires_at ? new Date(data.expires_at) < new Date() : false;
  const exhausted = data.redeemed_count >= data.max_redemptions;

  console.log(`\n${data.code}`);
  console.log(`  redemptions:   ${data.redeemed_count} / ${data.max_redemptions}`);
  console.log(`  expires_at:    ${data.expires_at ?? "(never)"}${expired ? "  [EXPIRED]" : ""}`);
  console.log(`  status:        ${exhausted ? "EXHAUSTED" : expired ? "EXPIRED" : "active"}`);
  console.log(`  created_at:    ${data.created_at}`);
  console.log("");
}

/** Page through auth users for an exact (case-insensitive) email match.
 *  gotrue's admin API has no server-side email filter, so this walks pages —
 *  fine for an operator one-off. EmailSchema lowercases at sign-up, but
 *  compare lowercased anyway in case the account predates that. */
async function findUserByEmail(
  db: ReturnType<typeof client>,
  email: string
): Promise<{ id: string; email: string } | null> {
  const needle = email.toLowerCase();
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) abort(`listUsers failed: ${error.message}`);
    for (const u of data.users) {
      if (u.email?.toLowerCase() === needle) return { id: u.id, email: u.email };
    }
    if (data.users.length < 200) return null;
  }
}

async function grant(flags: Record<string, string>) {
  const code = flags.code?.trim();
  if (!code) abort("--code is required (e.g. --code LAUNCH2026)");
  const email = flags.email?.trim();
  if (!email) abort("--email is required (e.g. --email user@example.com)");

  const db = client();

  const user = await findUserByEmail(db, email);
  if (!user) abort(`No user with email "${email}" was found.`);

  const { data: memberships, error: membershipError } = await db
    .from("memberships")
    .select("org_id, role, organizations(name)")
    .eq("user_id", user.id);
  if (membershipError) abort(`Membership lookup failed: ${membershipError.message}`);
  if (!memberships || memberships.length === 0) {
    abort(`${email} has no Team yet — the grant binds to a Team, so have them create one first.`);
  }

  let orgId = flags["org-id"] ?? null;
  if (orgId) {
    if (!memberships.some((m) => m.org_id === orgId)) {
      abort(`${email} is not a member of org ${orgId}.`);
    }
  } else if (memberships.length === 1) {
    orgId = memberships[0].org_id;
  } else {
    const list = memberships
      .map((m) => {
        const org = Array.isArray(m.organizations) ? m.organizations[0] : m.organizations;
        return `    ${m.org_id}  ${org?.name ?? "(unnamed)"}  [${m.role}]`;
      })
      .join("\n");
    abort(
      `${email} belongs to ${memberships.length} Teams — pass --org-id to pick one:\n${list}`
    );
  }

  // A second unconsumed redemption for the same org would make the checkout
  // benefit lookup (maybeSingle) error and fail closed — the Team would get NO
  // benefit at all. Refuse rather than silently break the existing one.
  const { data: existing, error: existingError } = await db
    .from("access_code_redemptions")
    .select("id, access_code_id")
    .eq("org_id", orgId!)
    .is("benefit_consumed_at", null);
  if (existingError) abort(`Redemption lookup failed: ${existingError.message}`);
  if (existing && existing.length > 0) {
    abort(
      `Org ${orgId} already has an unconsumed redemption (${existing[0].id}). ` +
        `A second one would break the checkout benefit lookup for this Team.`
    );
  }

  const { data: claimData, error: claimError } = await db.rpc("claim_access_code", {
    p_code: code,
  });
  if (claimError) abort(`Claim RPC failed: ${claimError.message}`);
  const claim = Array.isArray(claimData) ? claimData[0] : claimData;
  if (!claim?.claimed) {
    abort(`Claim refused: ${claim?.status ?? "no result"} (code "${code}")`);
  }

  const { error: insertError } = await db.from("access_code_redemptions").insert({
    access_code_id: claim.access_code_id,
    user_id: user.id,
    org_id: orgId,
  });
  if (insertError) {
    // Hand the slot back so redeemed_count doesn't run over-conservative.
    await db.rpc("release_access_code_claim", { p_access_code_id: claim.access_code_id });
    abort(`Redemption insert failed (claim released): ${insertError.message}`);
  }

  console.log(`\n✓ Granted access code "${code}"\n`);
  console.log(`  user:             ${user.email} (${user.id})`);
  console.log(`  org_id:           ${orgId}`);
  console.log(`  trial_days:       ${claim.trial_days ?? "(none)"}`);
  console.log(`  stripe_coupon_id: ${claim.stripe_coupon_id ?? "(none)"}`);
  console.log(`  plan_slug:        ${claim.plan_slug ?? "(any plan)"}`);
  console.log(
    `\n  The grant applies at this Team's next checkout` +
      (claim.plan_slug ? ` for the ${claim.plan_slug} plan.` : ".") +
      `\n`
  );
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (command === "mint") {
    await mint(flags);
    return 0;
  }
  if (command === "status") {
    await status(flags);
    return 0;
  }
  if (command === "grant") {
    await grant(flags);
    return 0;
  }

  console.error(
    "Usage:\n" +
      "  npm run access-codes:mint -- --code <CODE> --max-redemptions <N> " +
      "[--expires-at <ISO>] [--trial-days <N>] [--stripe-coupon-id <ID>] [--plan-slug <SLUG>]\n" +
      "  npm run access-codes:status -- --code <CODE>\n" +
      "  npm run access-codes:grant -- --code <CODE> --email <EMAIL> [--org-id <UUID>]"
  );
  return 1;
}

process.exit(await main());
