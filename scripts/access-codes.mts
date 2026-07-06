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

  console.error(
    "Usage:\n" +
      "  npm run access-codes:mint -- --code <CODE> --max-redemptions <N> " +
      "[--expires-at <ISO>] [--trial-days <N>] [--stripe-coupon-id <ID>] [--plan-slug <SLUG>]\n" +
      "  npm run access-codes:status -- --code <CODE>"
  );
  return 1;
}

process.exit(await main());
