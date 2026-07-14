import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Where global-setup writes the saved auth states + the dynamic seed lookup.
export const AUTH_DIR = path.join("e2e", ".auth");
export const SEED_FILE = path.join(AUTH_DIR, "seed.json");

const PASSWORD = "password123";

// The three seeded accounts (see scripts/seed-e2e.mjs). Two roles on Team A drive
// the role-based UI assertions; Contributor B exists only to own Team B's rubric,
// which Team A users must not be able to reach.
export const CONTRIBUTOR_A = {
  email: "dev@baseline.test",
  password: PASSWORD,
  storageState: path.join(AUTH_DIR, "contributor-a.json"),
};
export const READONLY_A = {
  email: "readonly@baseline.test",
  password: PASSWORD,
  storageState: path.join(AUTH_DIR, "readonly-a.json"),
};
export const CONTRIBUTOR_B = {
  email: "dev-b@baseline.test",
  password: PASSWORD,
  storageState: path.join(AUTH_DIR, "contributor-b.json"),
};
// Team C: the paid fixture (Builder via a seeded mirror row) for surfaces that
// require a paid plan — the optimization wizard and allowance metering (#181).
export const CONTRIBUTOR_C = {
  email: "dev-c@baseline.test",
  password: PASSWORD,
  storageState: path.join(AUTH_DIR, "contributor-c.json"),
};
// Team D: the BYO paid fixture (#485) — Builder-subscribed AND holding BYO OpenAI/Mistral keys,
// for the optimization wizard's live-model listing. Separate from Team C, whose keyless
// managed-mode state the managed-metering specs depend on.
export const CONTRIBUTOR_D = {
  email: "dev-d@baseline.test",
  password: PASSWORD,
  storageState: path.join(AUTH_DIR, "contributor-d.json"),
};
export const ROLES = [CONTRIBUTOR_A, READONLY_A, CONTRIBUTOR_B, CONTRIBUTOR_C, CONTRIBUTOR_D];

// Anonymous (signed-out) state — an empty storage state.
export const ANON_STATE = { cookies: [], origins: [] };

// Seeded entity names the specs assert against.
export const TEAM_A_NAME = "Acme Support (seed)";
export const TEAM_B_NAME = "Globex Sales (seed)";
export const TEAM_C_NAME = "Initech Data (seed)";
export const TEAM_B_RUBRIC_NAME = "Globex outbound email quality (seed)";
export const TEAM_C_RUBRIC_NAME = "Initech ticket triage (seed)";
export const TEAM_C_CONNECTION_NAME = "Initech triage agent (seed)";
export const TEAM_D_NAME = "Umbrella Labs (seed)";
export const TEAM_D_RUBRIC_NAME = "Umbrella reply quality (seed)";
export const TEAM_D_CONNECTION_NAME = "Umbrella agent (seed)";
export const RUBRIC_SUPPORT = "Support reply quality";
export const RUBRIC_SALES = "Sales email quality";
export const SCHEDULE_NAME = "Support agent — nightly (seed)";

// Rubric ids are generated fresh each seed; global-setup looks them up by name and
// writes them here (Team A for the detail route, Team B for cross-Team isolation).
export function readSeed(): {
  teamARubricId: string;
  teamBRubricId: string;
  teamAOrgId: string;
  teamBOrgId: string;
  teamCOrgId: string;
  teamDOrgId: string;
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
 * True once Mailpit holds a message whose subject contains `subjectFragment`
 * addressed to `toAddress`. For expect.poll — one definition of "the email
 * arrived" for every spec that asserts notifications.
 */
export async function mailpitHasEmail(
  subjectFragment: string,
  toAddress: string
): Promise<boolean> {
  const res = await fetch(`${MAILPIT_API}/api/v1/messages?limit=50`);
  if (!res.ok) return false;
  const body = (await res.json()) as {
    messages?: { Subject: string; To: { Address: string }[] }[];
  };
  return (body.messages ?? []).some(
    (m) =>
      m.Subject.includes(subjectFragment) &&
      m.To.some((t) => t.Address === toAddress)
  );
}
