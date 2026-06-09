# Local exploration with agent-browser

This is the **local-only** exploratory pass that feeds the Playwright suite. It uses
[`vercel-labs/agent-browser`](https://github.com/vercel-labs/agent-browser) — a
deterministic CDP browser CLI — driven by hand (or by Claude Code) to hunt for
accessibility, security, and functional issues across every surface. Each confirmed
issue becomes a failing Playwright spec that is then fixed in the same PR (TDD); the
green suite in `e2e/*.spec.ts` guards against regressions thereafter.

> agent-browser is **never** part of CI. CI runs only Playwright (`.github/workflows/ci.yml` → `e2e` job).

## Setup

```bash
npm install -g agent-browser && agent-browser install   # one-time
npm run db:start && npm run db:reset                     # local Supabase
SEED_ENV=development npm run seed:e2e                     # Team A/B + Readonly Member
npm run dev:next                                          # app on :3000
```

Sign-in fixtures (all `/ password123`, see `scripts/seed-e2e.mjs`):

| Account | Role | Team |
|---|---|---|
| `dev@baseline.test` | Contributor | Acme Support (seed) |
| `readonly@baseline.test` | Readonly Member | Acme Support (seed) |
| `dev-b@baseline.test` | Contributor | Globex Sales (seed) |

## Sweeps

Drive each surface (`/dashboard`, `/rubrics`, `/rubrics/<id>`, `/optimizations`,
`/schedules`, `/settings/team`, `/settings/account`, plus signed-out `/`, `/sign-in`).

**Accessibility** — the a11y tree + refs:
```bash
agent-browser open http://localhost:3000/sign-in
agent-browser snapshot -i          # interactive elements + roles + accessible names
```
Flag: controls with no accessible name, wrong/missing roles, missing landmarks,
focus traps, low-contrast text (cross-check with the Playwright axe scan).

**Functional** — drive flows and watch for errors:
```bash
agent-browser click @e3            # by snapshot ref
agent-browser fill @e5 "text"
agent-browser console              # console messages
agent-browser errors               # uncaught errors / failed requests
```

**Security** — isolation, authz, and hygiene:
```bash
# tenant isolation: as a Team A user, open a Team B resource id → expect 404/redirect
agent-browser open http://localhost:3000/rubrics/<team-B-rubric-id>
# headers + leaked data
agent-browser network har start
agent-browser open http://localhost:3000/dashboard
agent-browser network har stop out.har    # inspect Set-Cookie flags, response headers, payloads
```
Probe: cross-Team URLs, Readonly Member seeing write controls, signed-out redirects,
`active_org` cookie tampering, response security headers, secrets in the JS bundle.

## Findings backlog

Each becomes a `PR3..N` (failing spec → fix → green). Status updated as they land.

| id | class | severity | surface | finding | spec target |
|----|-------|----------|---------|---------|-------------|
| A1 | a11y | serious | `/`, `/dashboard`, `/rubrics`, `/rubrics/[id]` | Site-wide `color-contrast` failures on low-contrast gray text (zinc-400/500 on white/warm). Single design-token fix flips all four pages green. | broaden `e2e/a11y.spec.ts` to these routes |
| S1 | security | investigate | all authed | The Supabase session cookie (`sb-*-auth-token`) is **not** httpOnly. This is the `@supabase/ssr` default (the browser client reads it), so it is likely expected — but worth confirming it's chunked/scoped and that no longer-lived secret rides in a JS-readable cookie. Not asserted as a bug. | — (note only) |

> Header hygiene (CSP / HSTS / X-Frame-Options) and `active_org` cookie tampering
> were **not yet swept** — run those sweeps and append findings here before closing
> the exploration task.
