# Temporal foundation

Durable-orchestration substrate for the optimization loop (GEPA). See
`docs/adr/0006-temporal-for-durable-orchestration.md` for the why.

Issue #85 was the tracer bullet (`pingWorkflow`). Issue #87 added the first real workload:
the GEPA optimization spine — seed Candidate 0 and score it across a frozen instance set.

## Layout

| File            | Role                                                                 |
|-----------------|----------------------------------------------------------------------|
| `connection.ts` | The only place that reads Temporal address/namespace/TLS from env. Mirrored at `src/lib/temporal/connection.ts`. |
| `codec.ts`      | AES-256-GCM `PayloadCodec` → history holds ciphertext. Mirrored byte-for-byte at `src/lib/temporal/codec.ts`; **keep both in sync**. |
| `activities.ts` | Tracer `ping` + re-export of the GEPA (`../gepa/activities.ts`) and Eval Run (`../evalrun/activities.ts`) Activities. |
| `workflows.ts`  | Runs in Temporal's deterministic sandbox — no DB/Date/random. Re-exports `runOptimizationWorkflow`, `runSimpleOptimizationWorkflow`, and `runEvalWorkflow`. |
| `client.ts`     | Cached Temporal client for the worker's pgmq **dispatcher** — starts `runEvalWorkflow` for a scheduled run (pg_cron can't call Temporal). |
| `worker.ts`     | Registers the Temporal worker in the worker process — **unconditional** (Temporal is the sole executor). |

The GEPA workflow + Activities live under `../gepa/`; the Eval Run workflow + Activities under
`../evalrun/`; they are re-exported through the files above so the single bundled workflows path
+ the single `import * as activities` registration pick them up.

The Next app starts workflows via `src/app/actions/optimizations.ts` /
`src/app/actions/eval-runs.ts` → `getTemporalClient()`.

## The sole executor (#123, ADR-0006)

Temporal is **mandatory** — there is no flag and no pgmq execution path. `startTemporalWorker()`
runs unconditionally, and the worker process refuses to start if it can't register the Temporal
worker. Eval runs execute as `runEvalWorkflow`: interactive runs are started directly by
`createEvalRun`; scheduled runs go pg_cron → pgmq → the worker's thin **dispatcher**
(`worker.ts`), which starts the workflow and acks the message (pgmq stays only the scheduling
broker). All eval execution + billing (judge/target key resolution, managed metering, the
claim-time reserve gate, point settlement) lives in the Eval Run Activities.

## Verify locally (end-to-end)

1. **Install the CLI** (once): `curl -sSf https://temporal.download/cli.sh | sh`. Required
   because `npm run dev` now starts the dev server in its own pane (`dev:temporal`).
2. **Generate one shared key** and put the *same* base64 value in `TEMPORAL_ENCRYPTION_KEY`
   in **both** `.env.local` and `worker/.env.local`:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
3. No flag to set — Temporal is mandatory. The worker runs always-on (it no longer exits on
   idle), so the Temporal worker stays registered.
4. Run everything: `npm run dev`. The `temporal` pane serves the Web UI on
   http://localhost:8233; the worker connects to it (with a short retry to absorb the
   startup race) and logs `Temporal worker registered on task queue "baseline-optimizations"`.
5. **Trigger a workflow** — call the `startOptimizationRun(...)` server action with an agent
   Connection (that declares Modules), a Rubric, and a small instance set. It returns an
   `optRunId`.
6. **Observe** the run in the Web UI: `runOptimizationWorkflow` seeds Candidate 0, rolls it
   out across the instances, and completes. Event-history payloads show `binary/encrypted`
   ciphertext, not plaintext. In Postgres, `optimization_rollouts` + `rollout_results` are
   populated and the run's `best_candidate_id`/`best_score` are set.

## Temporal Cloud + cert rotation

In Cloud, the connection seam reads the mTLS client pair from `TEMPORAL_TLS_CERT` /
`TEMPORAL_TLS_KEY` (base64-encoded PEM) — see `connection.ts`. These are platform secrets,
not in source. Rotation is **restart-to-rotate**: the cert pair is read once at process
start (the client is cached, the worker connects once), so install the new pair as the
secret and redeploy/restart both the Next app and the worker to pick it up. Schedule
rotation comfortably inside the certificate lifetime — there is no hot-reload.
