import { defineConfig, devices } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

// Load .env.local for local runs so global-setup (which talks to Supabase with the
// service role) and the dev server see the same vars Next does. In CI the vars are
// exported by the workflow step, so there's no file to read. Minimal parser — we
// don't pull in a dotenv dependency just for this.
function loadEnvLocal() {
  if (process.env.CI || !existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
    process.env[key] = value;
  }
}
loadEnvLocal();

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

// Spec files that mutate a seeded Team's shared state across a wide window — run in a
// second phase after the read-heavy main pool (see the `mutating` project below).
const MUTATING_SPECS =
  /(?:(?:rubric|connection|schedule)-lifecycle|optimization-allowance)\.spec\.ts/;

// The launch-phase sign-up gate spec (ADR-0017, #425) drives a SHARED, unkeyed
// local PostHog mock (posthog-mock-server.mjs) that decides `signup-access-code-gate`
// for the whole app process — any concurrent /sign-up visit or signUp submission from
// another spec would race its toggling. Runs in its own project, strictly after both
// other phases finish, so it's the only thing hitting /sign-up while it's flipping
// the mock's state.
const SIGNUP_GATE_SPEC = /signup-gate\.spec\.ts/;

const POSTHOG_MOCK_PORT = Number(process.env.POSTHOG_MOCK_PORT ?? 4310);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry everywhere (not just CI): the local Supabase stack has a rare Kong↔PostgREST
  // keep-alive reuse race ("upstream prematurely closed connection") that 502s a random
  // request roughly once per full-suite run — most visibly the billing page's
  // managed_spend_total RPC. A retried pass is still reported as "flaky", so nothing hides.
  retries: 1,
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["list"]]
    : [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: [MUTATING_SPECS, SIGNUP_GATE_SPEC],
    },
    {
      // Shared-fixture writers with wide mutation windows: the lifecycle specs walk
      // multi-test serial create/mutate/delete arcs on Team A's rubrics/connections/
      // schedules (racing the main pool's seeded-state assertions and re-rendering its
      // lists mid-click), and optimization-allowance burns Team C's allowance to zero
      // inside each test body (racing every Team C reader's "+ New run is live" check).
      // Sequencing these writers after the main pool keeps both phases deterministic;
      // within this phase they touch disjoint teams.
      name: "mutating",
      use: { ...devices["Desktop Chrome"] },
      testMatch: MUTATING_SPECS,
      dependencies: ["chromium"],
    },
    {
      // Signup-gate specs toggle the shared PostHog mock's decision for the whole app
      // process (see SIGNUP_GATE_SPEC above) — isolate them to their own phase, after
      // every other spec (including "mutating") has finished touching /sign-up.
      name: "signup-gate",
      use: { ...devices["Desktop Chrome"] },
      testMatch: SIGNUP_GATE_SPEC,
      dependencies: ["chromium", "mutating"],
    },
  ],
  webServer: [
    {
      // CI builds first (separate step) then serves the production bundle; locally we
      // reuse an already-running `npm run dev:next`, or start one if none is up.
      command: process.env.CI ? "npm run start" : "npm run dev:next",
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        // Points the app's OWN server-side flag-evaluation client (signup-gate.ts) —
        // deliberately NOT the client bundle's NEXT_PUBLIC_POSTHOG_KEY/HOST — at the
        // local mock below. Read at request time (not NEXT_PUBLIC_*, so nothing here
        // needed to be baked in at the CI build step), so setting it only when the
        // server process starts is enough; the mock itself decides on/off/error/timeout
        // per e2e/signup-gate.spec.ts. Every other spec never touches the mock's control
        // endpoint, so it stays at its "off" default and behaves exactly as if PostHog
        // were unconfigured (the pre-existing e2e behavior).
        POSTHOG_KEY: "phc_e2e_mock",
        POSTHOG_HOST: `http://127.0.0.1:${POSTHOG_MOCK_PORT}`,
      },
    },
    {
      command: `node e2e/posthog-mock-server.mjs`,
      url: `http://127.0.0.1:${POSTHOG_MOCK_PORT}/__mock__/state`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { POSTHOG_MOCK_PORT: String(POSTHOG_MOCK_PORT) },
    },
  ],
});
