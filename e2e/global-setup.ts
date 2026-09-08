import { chromium, type FullConfig } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { AUTH_DIR, ROLES, RUBRIC_SUPPORT, SEED_FILE } from "./constants";
import { consentCookie } from "./fixtures";

// There is no sign-in (ADR-0020): every context is the Local Workspace's Contributor.
// Each role's storageState still exists so specs keep their `test.use({ storageState })`
// shape, but it carries only the consent cookie — identity is the same for all of them.
async function saveConsentState(baseURL: string, storagePath: string) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL });
    await context.addCookies([consentCookie(baseURL)]);
    await context.storageState({ path: storagePath });
  } finally {
    await browser.close();
  }
}

export default async function globalSetup(config: FullConfig) {
  const baseURL =
    (config.projects[0]?.use?.baseURL as string | undefined) ??
    "http://localhost:3000";

  mkdirSync(AUTH_DIR, { recursive: true });

  for (const role of ROLES) {
    await saveConsentState(baseURL, role.storageState);
  }

  // Resolve the seeded rubric's (dynamically-generated) id by name via the service role,
  // so the detail-route specs have a concrete id to open.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "global-setup: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — " +
        "did the seed run and is .env.local populated?",
    );
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  async function rubricByName(
    name: string,
  ): Promise<{ id: string; orgId: string }> {
    const { data, error } = await supabase
      .from("rubrics")
      .select("id, org_id")
      .eq("name", name)
      .single();
    if (error || !data) {
      throw new Error(
        `global-setup: could not find rubric "${name}" ` +
          `(${error?.message ?? "no row"}). Run: SEED_ENV=development npm run seed:e2e`,
      );
    }
    return { id: data.id as string, orgId: data.org_id as string };
  }

  const teamA = await rubricByName(RUBRIC_SUPPORT);
  const seed = { teamARubricId: teamA.id, teamAOrgId: teamA.orgId };
  writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));
}
