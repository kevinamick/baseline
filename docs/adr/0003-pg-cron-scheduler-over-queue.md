# Schedules fire via pg_cron + pg_net, reusing the existing worker

> **Status: Superseded by [ADR-0006](0006-temporal-for-durable-orchestration.md).** Still in
> service during the Temporal coexistence window; retires when schedules migrate to Temporal
> Schedules and eval-run execution moves to a Workflow.

Schedules need a timer that, unattended, notices when a Schedule is due and turns it into an Eval Run. We use **pg_cron** inside Supabase Postgres: a once-a-minute `tick_schedules()` selects due rows (`enabled AND next_run_at <= now()`, `FOR UPDATE SKIP LOCKED`), creates `queued` Eval Runs on the **existing `eval_runs` pgmq**, recomputes `next_run_at`, and uses **pg_net** to POST the existing worker wake URL. The worker then runs the unchanged manual-run executor path. No new service, no new queue.

## Considered options

**Schedule queue + dedicated schedule workers** — a delayed-message queue with workers that pop events whose run time `<= now`. Rejected: a queue does not solve *who wakes up at the right time*. The consumer must either poll continuously (an always-on process that cannot scale to zero — strictly more expensive than today, and a new deployable to operate) or be woken by a timer (which is pg_cron again, now with a queue bolted on). It also adds re-enqueue logic for the next occurrence and stale-message invalidation when a Schedule is edited or disabled — both of which pg_cron sidesteps by re-reading the live row every tick.

**Vercel Cron → API route** — a `vercel.json` cron hits a Next route each minute to dispatch due Schedules. Rejected: ties scheduling to the Vercel host, adds a second scheduling surface outside Postgres (where pgmq and the data already live), and requires securing the route. More moving parts for no benefit at this scale.

**External always-on scheduler service** — a dedicated polling process (e.g. a second Fly machine). Rejected: a whole new deployable to run and pay for; overkill for a realistic load of dozens of Schedules at hourly–monthly cadence.

## Notes

This is deliberately the small-scale instance of the standard *timer → broker → worker* pattern (pg_cron = timer, pgmq = broker, worker = executor). The interface — "mark due → enqueue → worker executes" — is identical to the billion-scale version, so growth is a swap (shard the scan, move the timer to a Redis ZSET / EventBridge Scheduler, add worker consumers, jitter `next_run_at` for hot timestamps), not a rewrite.

Related: connection auth secrets are stored in **Supabase Vault** (the row holds only `auth_secret_id`), decrypted by `service_role` in the worker and server actions — chosen over app-level encryption to avoid owning key management, and over a plaintext column for the obvious reason.
