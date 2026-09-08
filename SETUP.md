# Contributor setup

This is the from-source path: the app with hot reload, the worker, and the test suites. If you
just want to run Baseline, the README's `docker compose up` is all you need.

## Prerequisites

- **Node 22+** (`@supabase/supabase-js` needs a global `WebSocket`).
- **Docker Desktop** running (the Supabase CLI runs Postgres in it).
- **Supabase CLI**: `brew install supabase/tap/supabase` or `npm i -g supabase`.
- **Temporal CLI**: `curl -sSf https://temporal.download/cli.sh | sh`, then put
  `~/.temporalio/bin` on your PATH.
- An API key for at least one LLM provider (Anthropic, OpenAI, Google, or Mistral).

## 1. Install

```bash
npm install && npm install --prefix worker
```

## 2. Local database

```bash
npm run db:start        # first run pulls Docker images (~1-2 min); later runs are fast
```

The CLI prints the local URLs and keys. Copy the env examples and fill in the two Supabase
values plus your provider key:

```bash
cp .env.local.example .env.local
cp worker/.env.local.example worker/.env.local
```

```env
# .env.local
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from `supabase start`>
SUPABASE_SERVICE_ROLE_KEY=<service role key from `supabase start`>
ANTHROPIC_API_KEY=sk-ant-...
TEMPORAL_ENCRYPTION_KEY=<base64 32-byte key>

# worker/.env.local
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<same service role key>
ANTHROPIC_API_KEY=sk-ant-...
TEMPORAL_ENCRYPTION_KEY=<the SAME base64 key as the app>
```

Generate the encryption key once and paste it into both files:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Provider keys must be identical in both files: the worker uses them to judge and optimize,
and the app reads them to know a provider is usable. A key saved in the app under
**Settings → Provider keys** overrides the env var for that provider.

Apply the migrations (also re-runs them from scratch whenever you want a clean slate):

```bash
npm run db:reset
```

| Command | What it does |
|---|---|
| `npm run db:start` | Start the local Supabase stack (idempotent) |
| `npm run db:stop` | Stop the containers (data preserved) |
| `npm run db:reset` | Drop + recreate the DB and re-run every migration |
| `supabase migration up` | Apply newly pulled migrations without wiping data |
| `supabase status` | Show running services, URLs, and keys |

Supabase Studio is at <http://127.0.0.1:54323> while the stack runs.

## 3. Run everything

```bash
npm run dev      # Next (:3000) + the worker + the Temporal dev server (:7233, UI on :8233)
```

Open <http://localhost:3000>. There is no sign-in: you are the Workspace's Contributor
(ADR-0020). Interactive **Run eval** submissions start a Temporal workflow that the worker
executes; its Activity progress shows in the `[worker]` stream and in the Temporal Web UI.
Scheduled runs go through `pg_cron` → pgmq, which the worker's poll loop dispatches every 5s.

Local email (run notifications) lands in Mailpit at <http://127.0.0.1:54324>; the worker's
`MAILPIT_SMTP_*` defaults point there. Set `OPTIMIZATION_NOTIFY_EMAIL` in `worker/.env.local`
to receive optimization-run mail.

### Demo data

```bash
SEED_ENV=development npm run seed:e2e
```

Populates the Workspace with rubrics, completed eval runs (a rising score trend for the
dashboard), a schedule with run history, a dataset Connection, and a completed optimization
run — everything in a terminal state, so every screen has something on it. It refuses to run
against anything that looks like production. See `scripts/README-seed-e2e.md`.

To exercise the live agent paths against a local mock endpoint, see
`scripts/README-schedules-e2e.md` and `scripts/mock-agent.mjs`.

## 4. Tests

```bash
npm test                 # Vitest: app then worker
npm run lint
npm run typecheck && npm run typecheck --prefix worker
npx playwright test      # browser suite against the seeded local stack
```

The Playwright suite needs the local Supabase stack, the seed, and a Temporal dev server
(`temporal server start-dev`); it reuses an already-running `npm run dev:next` or starts one.
Every spec imports `test`/`expect` from `e2e/fixtures.ts` — see the testing notes in
`AGENTS.md`.

## 5. Migrations

Migrations live in `supabase/migrations/` and are applied by `supabase db reset` /
`supabase migration up` locally. Write a new one with `supabase migration new <name>` (or
`supabase db diff` after changing the schema in Studio), and add it to the `db` service's
volume list in `docker-compose.yml` so the compose stack picks it up on first boot.

## CI

`.github/workflows/ci.yml` runs lint, typecheck, both Vitest suites, a production build, and
the Playwright suite against an ephemeral local Supabase + Temporal on every PR. There is no
deploy step: Baseline is self-hosted.
