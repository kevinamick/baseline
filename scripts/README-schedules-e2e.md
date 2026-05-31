# Schedules — manual end-to-end test

Exercises the full path: wizard → Connection (Vault) → Schedule → tick → worker invokes the
agent live → rubric scoring → run history (+ optional email).

## 1. Prerequisites

- Migrations applied (`supabase db reset` locally, or pushed to your linked project).
- `worker/.env.local` has `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`.
  Add `RESEND_API_KEY` only if you want completion emails (otherwise leave recipients blank).
- Set **`WORKER_DEV_MODE=true`** in `worker/.env.local` so the worker keeps polling (every 5s)
  instead of scaling to zero — it will pick up scheduled runs without relying on the pg_net wake.

> Reachability note: the worker fetches the Connection's endpoint, so run the mock on the same
> host as the worker (local worker → `http://localhost:8787` works). If you run pg_cron on a
> hosted DB but the worker locally, the pg_net wake can't reach localhost — that's fine, the
> dev-mode poll covers it.

## 2. Start the mock agent

```bash
node scripts/mock-agent.mjs
# Mock agent listening on http://localhost:8787 (auth: off)
```

Leave it running; it logs each call. To test the auth path instead, start it with
`MOCK_AGENT_TOKEN=secret-123 node scripts/mock-agent.mjs` and in the wizard set
Auth header `Authorization`, Auth value `Bearer secret-123`.

## 3. Start the app + worker

```bash
npm run dev      # next + worker (+ stripe listener)
```

## 4. Create a rubric (if you don't have one)

On `/rubrics`, create **"Support reply quality"** with criteria (weights must sum to 1.0):

- **Accuracy** (0.5) — Does the answer correctly resolve the user's question vs. the expected answer?
- **Completeness** (0.3) — Does it include the key steps/details a user needs to act?
- **Tone** (0.2) — Is it friendly and professional?

## 5. Create the schedule (wizard on `/schedules` → New)

- **Basics:** name `Support agent — nightly`, rubric `Support reply quality`.
- **System → New connection:**
  - Endpoint URL: `http://localhost:8787/agent`
  - Auth header / value: **leave blank** (mock is public) — note the encryption callout.
  - Request body template: `{"input":"{{user_input}}"}` (default)
  - Response path: `output` (default)
- **Inputs:** add these five (User input → Expected output):

| User input | Expected output |
|---|---|
| How do I reset my password? | Click "Forgot password", enter email, use the emailed link (expires ~30 min). |
| What's your refund policy? | Full refund within 30 days; via billing email or in-app Billing → Request refund. |
| What are your support hours? | Mon–Fri, 9am–6pm Eastern; async replies next business day. |
| Can I export my data? | Settings → Data → Export; downloads a ZIP of CSVs. |
| Do you integrate with Salesforce? | Should clearly state whether a Salesforce integration exists. |

(The last one hits the mock's vague fallback → expect a lower score there.)

- **Cadence:** Daily at any hour (we trigger manually below), pick your timezone.
- **Notify:** add an email only if `RESEND_API_KEY` is set; otherwise leave blank.
- **Review → Create schedule.**

## 6. Trigger a run now (don't wait for the clock)

In the SQL editor / psql:

```sql
-- Spawn a run immediately (same thing pg_cron does every minute):
select public.tick_schedules();
-- …or just mark it due and let pg_cron pick it up within ~1 min:
-- update public.schedules set next_run_at = now() where name = 'Support agent — nightly';
```

Watch the mock agent terminal — you should see five `→ 200` lines as the worker invokes it.

## 7. Verify

```sql
-- The spawned run:
select id, status, overall_score, error_message, created_at
from public.eval_runs where schedule_id is not null order by created_at desc limit 1;

-- Outputs were filled live by the worker (no empty agent_output):
select row_index, left(agent_output, 40) as output
from public.eval_run_rows
where eval_run_id = '<run id>' order by row_index;

-- Per-criterion scores (expect the Salesforce row lower):
select row_index, criterion_name, score
from public.eval_run_results where eval_run_id = '<run id>' order by row_index, criterion_name;
```

Then in the UI: `/schedules` → select the schedule → the run appears under **Run history** with
its status and overall score. Toggle **Enabled** off and confirm `tick_schedules()` skips it.

## 8. Negative path (optional)

Point the Connection at a dead URL (`http://localhost:9999/agent`) and trigger — the run should
go `failed` with an error message (and a failure email if recipients/Resend are configured).
