# Temporal foundation

Durable-orchestration substrate for the optimization loop (GEPA). See
`docs/adr/0006-temporal-for-durable-orchestration.md` for the why.

This slice (issue #85) is the tracer bullet: a trivial `pingWorkflow` proven end-to-end.
Nothing GEPA-specific lives here yet.

## Layout

| File            | Role                                                                 |
|-----------------|----------------------------------------------------------------------|
| `connection.ts` | The only place that reads Temporal address/namespace/TLS from env. Mirrored at `src/lib/temporal/connection.ts`. |
| `codec.ts`      | AES-256-GCM `PayloadCodec` → history holds ciphertext. Mirrored byte-for-byte at `src/lib/temporal/codec.ts`; **keep both in sync**. |
| `activities.ts` | Where real data access lives (Postgres). Trivial `ping` for now.     |
| `workflows.ts`  | Runs in Temporal's deterministic sandbox — no DB/Date/random here.   |
| `worker.ts`     | Registers a Temporal worker in the worker process, gated by `TEMPORAL_ENABLED`. |

The Next app starts workflows via `src/app/actions/optimizations.ts` → `getTemporalClient()`.

## Coexistence

The Temporal worker is **opt-in**: unless `TEMPORAL_ENABLED=true`, `startTemporalWorker()`
is a no-op and the process runs exactly as before (pgmq/pg_cron eval-runs + schedules
untouched).

## Verify locally (end-to-end)

1. **Install the CLI** (once): `curl -sSf https://temporal.download/cli.sh | sh`
2. **Start the dev server** (Postgres + Web UI on http://localhost:8233):
   `temporal server start-dev`
3. **Generate one shared key** and put the *same* base64 value in
   `TEMPORAL_ENCRYPTION_KEY` in **both** `.env.local` and `worker/.env.local`:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
4. Set `TEMPORAL_ENABLED=true` in `worker/.env.local`.
5. Run the app + worker: `npm run dev` (worker dev keeps running via `WORKER_DEV_MODE`).
6. **Trigger a workflow** — call the `startPing("hello")` server action (e.g. from a
   throwaway button or a server-side caller). It returns a `workflowId`.
7. **Observe** the run in the Web UI: it completes, and the event history payloads show
   `binary/encrypted` ciphertext, not plaintext.
