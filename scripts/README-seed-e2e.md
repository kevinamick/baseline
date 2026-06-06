# Full e2e demo seed

`scripts/seed-e2e.mjs` populates one signed-in user with a fully-exercised team so you can
click through **dashboards, rubrics, eval runs, schedules, and optimizations** immediately —
no worker, Temporal, or mock agent required.

It seeds everything in a **terminal state** (runs already `completed`, with rows + per-criterion
results). To drive the *live* paths instead (worker invocation, the GEPA workflow), use
[`README-schedules-e2e.md`](./README-schedules-e2e.md) + `scripts/mock-agent.mjs`.

## Dev / staging only — never production

The script hard-refuses if `NODE_ENV` or `VERCEL_ENV` is `production`, and otherwise requires
an explicit `SEED_ENV` opt-in naming the non-prod target:

```bash
# Local (loads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local):
SEED_ENV=development npm run seed:e2e

# Staging (point env-file at your staging credentials):
SEED_ENV=staging node --env-file=.env.staging scripts/seed-e2e.mjs
```

Without `SEED_ENV` (or with a production marker present) it exits non-zero and writes nothing.
It also warns if `SEED_ENV=development` while the target URL isn't local — a likely misconfig.

## What it creates

| Surface       | Seeded data |
|---------------|-------------|
| Account       | User `dev@baseline.test` / `password123` (email pre-confirmed — sign in directly) |
| Team          | "Acme Support (seed)" org with the user as admin |
| Rubrics       | "Support reply quality" (Accuracy/Completeness/Tone) + "Sales email quality" |
| Eval runs     | 5 completed runs per rubric over ~75 days with a **rising score trend** + per-criterion results |
| Connection    | Agent Connection with **two** optimizable Modules (`{{prompt:system}}`, `{{prompt:style}}`), endpoint = the local mock |
| Schedule      | Daily agent schedule with its input set; two runs attributed to it (run history) |
| Optimization  | One **completed** optimization run: candidate 0 (seed prompts), frozen instances, rollouts + results, `best_candidate_id` + `workflow_id` set |

## Ready for the optimization UI

When the optimization UI lands, this seed is set up so the full e2e is testable without extra prep:

- **A run to view** — the completed optimization run (with candidate, rollouts, per-criterion results, best score) populates any detail/history view.
- **Startable config** — the agent Connection declares two Modules and a Rubric exists, so the UI's "start optimization" flow has a valid System + Rubric to pick.
- **The 1-active slot is free** — the seeded run is `completed`, not `running`, so starting a fresh run from the UI won't hit the one-active-per-org guard.
- **Live runs reach a real endpoint** — locally that's the mock (`scripts/mock-agent.mjs`); on staging, set `SEED_AGENT_ENDPOINT` to a reachable agent so a UI-started run can actually invoke it.

> Only candidate 0 is seeded — that's faithful to the current engine (#87 is seed-only). Child candidates / generations arrive with reflective mutation (#88) and the budgeted loop (#89); extend the seed to add lineage once those land.

## Idempotency

Re-running first tears down the prior seed team (cascades all its data) and the seed auth user,
then recreates from scratch — so it's safe to run repeatedly.

> The Connection endpoint points at `http://localhost:8787/agent` (the mock). Seeded runs don't
> call it; it's only reachable if you later start the mock and trigger a live run/optimization.
