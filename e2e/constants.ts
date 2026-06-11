import { readFileSync } from "node:fs";
import path from "node:path";

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
export const ROLES = [CONTRIBUTOR_A, READONLY_A, CONTRIBUTOR_B];

// Anonymous (signed-out) state — an empty storage state.
export const ANON_STATE = { cookies: [], origins: [] };

// Seeded entity names the specs assert against.
export const TEAM_A_NAME = "Acme Support (seed)";
export const TEAM_B_NAME = "Globex Sales (seed)";
export const TEAM_B_RUBRIC_NAME = "Globex outbound email quality (seed)";
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
} {
  return JSON.parse(readFileSync(SEED_FILE, "utf8"));
}
