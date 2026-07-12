/**
 * Enable the `before_user_created` signup-pass auth hook (#487, ADR-0017) on a
 * HOSTED Supabase project via a SCOPED Management API PATCH.
 * ─────────────────────────────────────────────────────────────────────────────
 * Same disconnect as the auth email templates (#346): `config.toml`'s
 * `[auth.hook.before_user_created]` block drives only the LOCAL stack; a hosted
 * project's hook config lives in the Dashboard / Management API, and nothing
 * syncs the two. And as with #346, `supabase config push` is the wrong tool —
 * it applies the ENTIRE `[auth]` block and could clobber Dashboard-configured
 * OAuth state or the redirect allow-list. This script PATCHes
 * `/v1/projects/{ref}/config/auth` with ONLY the two
 * `hook_before_user_created_*` fields (both documented in the Management API's
 * UpdateAuthConfigBody schema), reading their values from config.toml so it
 * stays the single source of truth.
 *
 * ORDER MATTERS on first rollout: the hook function ships in
 * supabase/migrations/20260712000000_signup_passes.sql and the pass mint in the
 * app's signUp action — BOTH must be deployed to the target environment before
 * the hook is enabled, or every sign-up is rejected (no passes exist and
 * GoTrue can't find the function). Run this only after the migration has been
 * pushed and the app deploy is live.
 *
 * Usage (mirrors push:auth-emails):
 *   SUPABASE_PROJECT_ID_PROD=<ref> SUPABASE_ACCESS_TOKEN=<token> npm run push:auth-hook
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const CONFIG_PATH = join(repoRoot, "supabase", "config.toml");

/** Read a single field out of the `[auth.hook.before_user_created]` section. */
function readHookField(toml: string, field: "enabled" | "uri"): string {
  const header = "[auth.hook.before_user_created]";
  const start = toml.indexOf(header);
  if (start === -1) throw new Error(`config.toml is missing ${header}`);
  const rest = toml.slice(start + header.length);
  const nextHeader = rest.search(/\n\[/);
  const section = nextHeader === -1 ? rest : rest.slice(0, nextHeader);
  const match = section.match(new RegExp(`^${field}\\s*=\\s*"?([^"\\n]*)"?\\s*$`, "m"));
  if (!match) throw new Error(`config.toml ${header} is missing a "${field}" line`);
  return match[1].trim();
}

async function main(): Promise<number> {
  const ref = process.env.SUPABASE_PROJECT_ID_PROD;
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref || !token) {
    console.error(
      "Set SUPABASE_PROJECT_ID_PROD and SUPABASE_ACCESS_TOKEN before running.",
    );
    return 1;
  }

  const toml = readFileSync(CONFIG_PATH, "utf8");
  const body = {
    hook_before_user_created_enabled: readHookField(toml, "enabled") === "true",
    hook_before_user_created_uri: readHookField(toml, "uri"),
  };

  const res = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/config/auth`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    console.error(`PATCH failed: HTTP ${res.status}\n${await res.text()}`);
    return 1;
  }
  console.log(
    `before_user_created hook: enabled=${body.hook_before_user_created_enabled} ` +
      `uri=${body.hook_before_user_created_uri} (HTTP ${res.status})`,
  );
  return 0;
}

process.exit(await main());
