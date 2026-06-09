import { chromium, type FullConfig } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  AUTH_DIR,
  ROLES,
  RUBRIC_SUPPORT,
  SEED_FILE,
  TEAM_B_RUBRIC_NAME,
} from "./constants";

// Sign a role in through the real form once and persist its session, so specs
// attach a storageState instead of logging in on every test.
async function saveAuthState(
  baseURL: string,
  email: string,
  password: string,
  storagePath: string,
) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    // Sign-in redirects to /dashboard on success.
    await page.waitForURL("**/dashboard", { timeout: 30_000 });
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
    await saveAuthState(baseURL, role.email, role.password, role.storageState);
  }

  // Resolve Team B's (dynamically-generated) rubric id by name via the service role,
  // so the cross-Team isolation spec has a concrete id to probe.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "global-setup: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — " +
        "did the seed run and is .env.local populated?",
    );
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  async function rubricIdByName(name: string): Promise<string> {
    const { data, error } = await supabase
      .from("rubrics")
      .select("id")
      .eq("name", name)
      .single();
    if (error || !data) {
      throw new Error(
        `global-setup: could not find rubric "${name}" ` +
          `(${error?.message ?? "no row"}). Run: SEED_ENV=development npm run seed:e2e`,
      );
    }
    return data.id as string;
  }

  const seed = {
    teamARubricId: await rubricIdByName(RUBRIC_SUPPORT),
    teamBRubricId: await rubricIdByName(TEAM_B_RUBRIC_NAME),
  };
  writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));
}
