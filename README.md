# Baseline

An open-source LLM evaluation platform. Author **Rubrics**, run **Eval Runs** against your
agent's outputs, schedule them, and let an **Optimization Run** rewrite your prompts until they
score better. It runs on your machine with your own LLM provider keys: no account, no sign-in,
no card.

## What it does

- **Rubrics & Eval Runs** — define weighted, criterion-based rubrics and run them against agent
  outputs or uploaded rows, with per-criterion scores and natural-language reasoning.
- **Connections** — reusable definitions of how Baseline reaches a System: an `agent` endpoint
  it invokes live, a **Managed Agent** (a prompt Baseline runs on your key), or a `dataset`
  source it reads historical rows from.
- **Schedules** — spawn Eval Runs on a cadence against a connected System.
- **Optimization** — evolve an agent's prompts to score better against a Rubric. Two modes:
  **Simple** (Monte Carlo rewrite search, the default for paste-a-prompt Managed Agents) and
  **Reflective** / GEPA (reflection + Pareto selection, for external agents or richer criteria).
  See [`worker/src/gepa/README.md`](worker/src/gepa/README.md).

The domain vocabulary is defined in [`CONTEXT.md`](CONTEXT.md); design decisions live in
[`docs/adr/`](docs/adr/).

## Quickstart (Docker)

Requirements: Docker with Compose, and an API key for at least one of Anthropic, OpenAI, Google,
or Mistral.

```bash
git clone https://github.com/kevinamick/baseline.git
cd baseline
cp .env.example .env        # then set ANTHROPIC_API_KEY (or another provider's key)
docker compose up
```

Open <http://localhost:3000>. You land on the dashboard as the Workspace's Contributor. Create
a rubric, click **Run eval**, paste a user input and an agent output, and the worker judges it
on your key. The Temporal Web UI (durable run history) is at <http://localhost:8233>.

The first `up` builds two images and pulls Postgres, PostgREST, Caddy, and Temporal; later
starts are fast. `docker compose down -v` wipes the database.

## How keys work

A run resolves a provider's key in one order everywhere: a key saved under **Settings →
Provider keys** wins, else the provider's env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`, `MISTRAL_API_KEY`), else the run fails closed and says which key is missing.
Nothing is metered; token costs go straight to the provider.

## Stack

- **Web** — [Next.js 16](https://nextjs.org) (App Router) + React 19 + TypeScript + Tailwind.
- **Data** — Postgres with the Supabase extensions (pg_cron, pg_net, pgmq, Vault for stored
  keys), reached through PostgREST with the Supabase client libraries. No auth service.
- **Worker** — a separate Node service (`worker/`) running a [Temporal](https://temporal.io)
  worker with LLM clients for Anthropic, OpenAI, Google, and Mistral.
- **Durable orchestration** — Temporal runs every eval run and the long-lived optimization loop
  ([ADR-0006](docs/adr/0006-temporal-for-durable-orchestration.md)); Postgres stays the system
  of record.
- **Observability** — optional PostHog (analytics, logs, error tracking); off unless configured.

> **Heads-up:** this is Next.js **16**, which has breaking changes from earlier majors
> (e.g. `src/proxy.ts` instead of `middleware.ts`). See [`AGENTS.md`](AGENTS.md) before
> writing app code.

## Repository layout

| Path | What's there |
|---|---|
| `src/app/` | Next App Router — routes (`rubrics`, `schedules`, `optimizations`, `settings`, …), server `actions/`, and shared `_components/`. |
| `src/lib/` | Server/client libraries — `supabase`, `auth` (the Local Workspace), `temporal`, `validation` (Zod schemas), `optimization`, `llm` (key resolution), `analytics`. |
| `worker/` | The Temporal worker: `src/gepa/` (the optimization loop), `src/evalrun/` (the eval-run workflow + Activities), `src/providers/` (LLM clients, key resolution), the agent invoker, evaluator, and emailer. |
| `supabase/` | Migrations and the local `config.toml` for the Supabase CLI. |
| `docker-compose.yml`, `Dockerfile`, `worker/Dockerfile`, `docker/` | The one-command stack. |
| `docs/adr/` | Architecture Decision Records. |
| `scripts/` | Local helpers (`seed-e2e.mjs` demo data, `mock-agent.mjs`, …). |

## Contributing

Contributor setup (running the app from source with hot reload, the test suites, the e2e
harness) is in [`SETUP.md`](SETUP.md). The short version:

```bash
npm install && npm install --prefix worker
cp .env.local.example .env.local && cp worker/.env.local.example worker/.env.local
npm run db:start          # local Supabase via the Supabase CLI (Docker)
npm run dev               # Next + worker + Temporal dev server
```

Then `npm test` (Vitest, app + worker), `npm run lint`, `npm run typecheck`, and
`npx playwright test` for the browser suite.

## License

A license file has not been chosen yet; add one before publishing.
