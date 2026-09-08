import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Where global-setup writes the saved auth states + the dynamic seed lookup.
export const AUTH_DIR = path.join("e2e", ".auth");
export const SEED_FILE = path.join(AUTH_DIR, "seed.json");

// There is no sign-in (ADR-0020). Every spec runs as the Local Workspace's Contributor; the
// saved storageState carries only the consent cookie (see global-setup.ts).
export const CONTRIBUTOR_A = {
  storageState: path.join(AUTH_DIR, "contributor-a.json"),
};
export const ROLES = [CONTRIBUTOR_A];

// A fresh context with no saved state — the same Workspace, just no consent cookie.
export const ANON_STATE = { cookies: [], origins: [] };

// Seeded entity names the specs assert against (all in the one Workspace).
export const TEAM_A_NAME = "Acme Support (seed)";
export const TEAM_C_RUBRIC_NAME = "Initech ticket triage (seed)";
export const TEAM_C_CONNECTION_NAME = "Initech triage agent (seed)";
export const TEAM_D_RUBRIC_NAME = "Umbrella reply quality (seed)";
export const TEAM_D_CONNECTION_NAME = "Umbrella agent (seed)";
export const RUBRIC_SUPPORT = "Support reply quality";
export const RUBRIC_SALES = "Sales email quality";
export const SCHEDULE_NAME = "Support agent — nightly (seed)";

// Rubric ids are generated fresh each seed; global-setup looks them up by name and
// writes them here (the detail route needs a concrete id).
export function readSeed(): {
  teamARubricId: string;
  teamAOrgId: string;
} {
  return JSON.parse(readFileSync(SEED_FILE, "utf8"));
}

/**
 * Service-role Supabase client for spec setup/teardown, or null when the local
 * env isn't configured. One construction site for every spec that needs it.
 */
export function makeAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

/** Mailpit's local API — the e2e stack's email sink. */
export const MAILPIT_API = "http://127.0.0.1:54324";

/**
 * How many Mailpit messages match `subjectFragment` addressed to `toAddress`.
 * For expect.poll — the one definition of "the email arrived" (via
 * `mailpitHasEmail` below) and of "it arrived again" (#498's resend specs
 * assert a count >= 2). Uses Mailpit's search API filtered server-side by
 * recipient rather than a newest-N page of the whole inbox: a busy parallel
 * suite writes mail constantly, and a fixed newest-50 window can page the
 * target message out entirely and flake the assertion.
 */
export async function countMailpitMessages(
  subjectFragment: string,
  toAddress: string
): Promise<number> {
  const query = encodeURIComponent(`to:"${toAddress}"`);
  const res = await fetch(`${MAILPIT_API}/api/v1/search?query=${query}&limit=200`);
  if (!res.ok) return 0;
  const body = (await res.json()) as {
    messages?: { Subject: string; To: { Address: string }[] }[];
  };
  return (body.messages ?? []).filter(
    (m) =>
      m.Subject.includes(subjectFragment) &&
      m.To.some((t) => t.Address === toAddress)
  ).length;
}

/**
 * True once Mailpit holds a message whose subject contains `subjectFragment`
 * addressed to `toAddress`. Derived from `countMailpitMessages` so there is
 * exactly one definition of "the email arrived".
 */
export async function mailpitHasEmail(
  subjectFragment: string,
  toAddress: string
): Promise<boolean> {
  return (await countMailpitMessages(subjectFragment, toAddress)) > 0;
}
