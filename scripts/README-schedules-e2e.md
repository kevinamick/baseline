# Schedules — manual end-to-end test

Exercises the full path: wizard → Connection (Vault) → Schedule → tick → worker → rubric
scoring → run history (+ optional email), for **both** connection kinds:

- **agent** (§2–8): the worker invokes your System live each fire to produce outputs, then scores.
- **dataset** (§9–11): the worker reads complete historical rows (input + output) from a source
  and scores a sample — a custom HTTP log API (§9), the `skipped` empty-window path (§10), and
  PostHog (§11).

## 1. Prerequisites

- Migrations applied (`supabase db reset` locally, or pushed to your linked project).
- `worker/.env.local` has `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`.
  Add `RESEND_API_KEY` only if you want completion emails (otherwise leave recipients blank).
- The worker runs always-on (it no longer exits on idle), so it keeps polling (every 5s) and
  picks up scheduled runs without relying on the pg_net wake — no dev-mode flag needed.

> Reachability note: the worker fetches the Connection's endpoint, so run the mock on the same
> host as the worker (local worker → `http://localhost:8787` works). If you run pg_cron on a
> hosted DB but the worker locally, the pg_net wake can't reach localhost — that's fine, the
> dev-mode poll covers it.

## 2. Start the mock agent

```bash
node scripts/mock-agent.mjs
# Mock System listening on http://localhost:8787 (auth: off)
#   agent   →  POST .../agent   body {"input":"{{user_input}}"}  path: output
#   dataset →  GET  .../logs    rows path: data  (5 rows)
```

One process serves **both** kinds: `POST /agent` (agent, §5) and `GET /logs` (dataset, §9).
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
  - Endpoint URL: `http://localhost:8787/agent` (http is allowed in development; production requires https)
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

---

# Dataset path

A **dataset** Schedule has no fixed inputs. Each fire the worker queries a source for complete
rows (input **and** output already present), inserts them, and scores — so there's no live
invocation. Reuse the same rubric (§4) and the same running mock (§2 — it also serves `GET /logs`).

## 9. Custom HTTP dataset source

Create a second schedule on `/schedules` → **New**:

- **Basics:** name `Prod sample — custom`, rubric `Support reply quality`.
- **System → New connection → type `Custom data source`:**
  - Endpoint URL: `http://localhost:8787/logs`
  - Auth header / value: **leave blank** (or set them if you launched the mock with a token).
  - Query params template (default is fine):
    ```json
    { "from": "{{window_start}}", "to": "{{window_end}}", "limit": "{{max_rows}}" }
    ```
  - Rows path: `data`
  - `user_input` path: `prompt`  ·  `agent_output` path: `completion`
- **Cadence:** **Hourly** (no input set step appears — that's expected). On this step set
  **Lookback window** and **Max rows** (e.g. `60` / `100`; defaults are prefilled from the frequency).
- **Notify / Review → Create schedule.**

Trigger it the same way as §6:

```sql
select public.tick_schedules();
```

Watch the mock terminal for a single `→ 200  GET /logs … rows=5` line (one fetch, not one per row).

**Verify** the worker fetched + inserted the rows, then scored them:

```sql
select id, status, overall_score, error_message, created_at
from public.eval_runs where schedule_id is not null order by created_at desc limit 1;

-- Rows were created from the source (both input AND output populated):
select row_index, left(user_input, 30) as input, left(agent_output, 30) as output
from public.eval_run_rows where eval_run_id = '<run id>' order by row_index;
```

The run lands `completed` in **Run history** with an overall score. Note the row count can vary
run-to-run (it's whatever the window returns, capped by Max rows) — unlike an agent schedule's
fixed set.

## 10. Empty window → `skipped` (no email)

A dataset window that returns no usable rows is **not** a failure (quiet traffic is normal) and
**not** a success (nothing was scored). It terminates as `skipped`, sends no email, and is excluded
from score trends.

Restart the mock so `/logs` returns zero rows, then trigger again:

```bash
# stop the mock (Ctrl-C), then:
MOCK_LOGS_EMPTY=1 node scripts/mock-agent.mjs
```

```sql
select public.tick_schedules();

select status, error_message from public.eval_runs
where schedule_id is not null order by created_at desc limit 1;
-- → status = 'skipped', error_message = 'No rows returned for the configured window'
```

In the UI the run shows a grey **skipped** badge (hover for the note). Restart the mock without
`MOCK_LOGS_EMPTY` to go back to normal.

## 11. PostHog dataset source (real project)

This one needs a real PostHog project with LLM-analytics events (`$ai_generation`) and a personal
API key — there's no local mock for it.

- **System → New connection → type `PostHog data source`:**
  - Host: `https://us.posthog.com` (or `https://eu.posthog.com` / your self-hosted URL)
  - Project id: your numeric project id
  - Personal API key: paste the **raw** key (Baseline prepends `Bearer ` and stores it in Vault)
  - HogQL: the prefilled default selects `$ai_input` / `$ai_output_choices` aliased to
    `user_input` / `agent_output`. Your query **must** return columns named `user_input` and
    `agent_output` (optionally `expected_output`, `retrieval_context`); the worker maps results by
    those aliases. Keep the `{{window_start}}` / `{{window_end}}` / `{{max_rows}}` placeholders.
- **Cadence:** set window/max rows as in §9, then trigger with `select public.tick_schedules();`.

Verify the same way as §9. If your query returns no rows in the window, you'll see `skipped` (§10);
an auth/HogQL error lands the run `failed` with the PostHog error surfaced in `error_message`.

> Tip: validate the HogQL in PostHog's SQL editor first (aliasing the columns to `user_input` /
> `agent_output`). An inline "Test query" preview in the wizard is tracked as a follow-up (issue #39).
