# Baseline

An LLM evaluation platform. Teams author **Rubrics** and run evaluations against AI
outputs — one-off, on a recurring **Schedule**, or as an **Optimization Run** that
automatically improves an agent's prompts.

## What it does

- **Rubrics & Eval Runs** — define weighted, criterion-based rubrics and run them against
  agent outputs or uploaded rows, with per-criterion scores and natural-language reasoning.
- **Connections** — reusable definitions of how Baseline reaches a System: an `agent`
  endpoint it invokes live, or a `dataset` source it reads historical rows from.
- **Schedules** — spawn Eval Runs on a cadence against a connected System.
- **Optimization loop (GEPA)** — evolve an agent's prompts to score better against a Rubric,
  using reflective mutation + Pareto selection. See
  [`worker/src/gepa/README.md`](worker/src/gepa/README.md).
- **Teams** — every Rubric, Connection, Schedule, and run is owned by a Team, with
  Contributor / Readonly Member roles.

The domain vocabulary is defined in [`CONTEXT.md`](CONTEXT.md).

## Stack

- **Web** — [Next.js 16](https://nextjs.org) (App Router) + React 19 + TypeScript +
  Tailwind, deployed on Vercel.
- **Data & auth** — Supabase (Postgres + Supabase Auth). The service-role client is
  server-only; RLS scopes everything else.
- **Worker** — a separate Node service (`worker/`) running a
  [Temporal](https://temporal.io) worker and the Anthropic SDK, deployed on Fly.
- **Durable orchestration** — Temporal runs the long-lived optimization loop
  (see [ADR-0006](docs/adr/0006-temporal-for-durable-orchestration.md)); Postgres stays the
  system of record.
- **Billing** — Stripe. **Email** — Resend. **Observability** — PostHog (analytics, logs, error tracking).

> **Heads-up:** this is Next.js **16**, which has breaking changes from earlier majors
> (e.g. `src/proxy.ts` instead of `middleware.ts`). See [`AGENTS.md`](AGENTS.md) before
> writing app code.

## Repository layout

| Path | What's there |
|---|---|
| `src/app/` | Next App Router — routes (`rubrics`, `schedules`, `optimizations`, `settings`, …), `api/`, and server `actions/`. |
| `src/lib/` | Server/client libraries — `supabase`, `auth`, `temporal` (client seam + codec), `validation` (Zod schemas), `optimization`, `analytics`, `email`. |
| `worker/` | The Temporal worker: `src/gepa/` (the optimization loop), `src/temporal/` (the durable substrate), the agent invoker, evaluator, and emailer. |
| `supabase/` | Migrations and local `config.toml`. |
| `docs/adr/` | Architecture Decision Records. |
| `scripts/` | Local/e2e helpers (`seed-e2e.mjs`, `mock-agent.mjs`, …). |

## Getting started

Full one-time setup (Supabase CLI, OAuth, Stripe, environments, branch model) is in
[`SETUP.md`](SETUP.md). The short version for local development:

**Prerequisites:** Node, Docker Desktop (for local Supabase), the
[Supabase CLI](https://supabase.com/docs/guides/cli), the
[Temporal CLI](https://docs.temporal.io/cli), and the
[Stripe CLI](https://docs.stripe.com/stripe-cli) (only for webhook-touching work).

```bash
# 1. Install deps (root + worker)
npm install && npm install --prefix worker

# 2. Configure env — copy and fill in
cp .env.local.example .env.local
#    the worker reads worker/.env.local (Supabase, Anthropic, Temporal, Resend)

# 3. Start local Supabase (Postgres + Auth + Mailpit)
npm run db:start

# 4. Run everything (Next + Stripe listener + worker + Temporal dev server)
npm run dev
```

Open <http://localhost:3000>. The Temporal Web UI is at <http://localhost:8233>, and
local auth emails land in Mailpit (<http://localhost:54324>).

> `npm run dev` runs the Temporal dev server and worker via `concurrently`; both need the
> Temporal CLI on your `PATH`. You can also start pieces individually — `npm run dev:next`,
> `npm run dev:worker`, `npm run dev:temporal`.

### Seed demo data

```bash
SEED_ENV=development npm run seed:e2e   # seeds a demo team, rubric, and agent connection
```

To exercise the optimization loop end-to-end, also run the mock agent
(`node scripts/mock-agent.mjs`) and trigger a run — see
[`worker/src/gepa/README.md`](worker/src/gepa/README.md#running-it-locally).

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Next + Stripe listener + worker + Temporal dev server. |
| `npm run build` / `npm start` | Production build / serve. |
| `npm test` | Vitest (app) + the worker's Vitest suite. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit`. |
| `npm run db:start` / `db:stop` / `db:reset` | Local Supabase lifecycle. |

## Testing

Tests run on **Vitest** (`npm test`); the default environment is `node`. For DOM-related
code (rendering a client component, user events), opt a `*.dom.test.tsx` file into jsdom
with a first-line docblock and use React Testing Library:

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
```

jest-dom matchers are registered globally via `vitest.setup.ts`. See `AGENTS.md` for details.

## Architecture & conventions

- **[`CONTEXT.md`](CONTEXT.md)** — the domain glossary (Team, Rubric, Eval Run, Connection,
  Optimization Run, …).
- **[`docs/adr/`](docs/adr/)** — why the big calls were made (Temporal, Supabase Auth,
  pg_cron→Temporal, dataset Connections, …).
- **[`AGENTS.md`](AGENTS.md)** — coding conventions and the Next.js 16 caveats.
- **[`SETUP.md`](SETUP.md)** — environments and the `main` / `develop` / `feature/*` branch model.

## Branches

`main` is production, `develop` is staging; feature branches PR into `develop`. See
[`SETUP.md`](SETUP.md) for the full flow.
