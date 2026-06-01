# Dataset Connections fetch via per-provider adapters, not just custom HTTP

## Status

accepted

## Context

Slice 1 shipped `agent`-kind Connections: Baseline holds a fixed input set and **invokes** the customer's endpoint each tick to produce `agent_output`, then scores. Slice 2 adds the inverse — `dataset`-kind Connections that **read complete historical rows** (input *and* output already present) from where the customer already logs production traffic, and score a sample on a cadence.

We want first-class built-in sources (App Insights, CloudTrail, Cloud Logging, PostHog, …) plus a configurable custom source. The tempting shortcut is "a built-in is just a pre-filled custom-HTTP template." That breaks immediately: those sources share neither an **auth model** (Azure AD OAuth, AWS SigV4 signing, GCP service-account JWT, simple API key) nor a **query language** (KQL, LookupEvents filters, GCP filter syntax, HogQL) nor a response shape. SigV4 is not a header you can paste into a Vault secret.

## Decision

A `dataset` source is a **provider adapter**, discriminated by `connections.provider` (the column already existed from slice 1). Each adapter owns its auth, query, and parse, and implements one seam:

```
fetchRows(connection, windowStart, windowEnd, maxRows) → Row[]
```

…which feeds the shared "insert `eval_run_rows` → score" tail. `provider = 'custom'` is simply one adapter (the generic `endpoint` + request-template + `response_path` + `field_map` engine). The adapter is the *only* thing that varies; everything downstream is identical to a manual run.

**Slice 2 ships exactly two adapters — `custom` and `posthog`** — and defers the three cloud providers behind the now-proven seam. PostHog is the tracer bullet: its auth is a single API key in a header (fits slice 1's Vault mechanism with zero new infra), HogQL is SQL (so column aliases *are* the field mapping), and LLM traces plausibly already live there. The cloud providers each need heavyweight cloud auth and are better tackled one slice at a time.

Supporting choices:

- **`connections.config jsonb`** holds the provider-specific bits (`custom`: `field_map`; `posthog`: `project_id` + `hogql`); shared fields stay typed columns. `response_path` is reused as the universal "path to data" (`agent` = value path, `custom` = rows-array path, `posthog` = `results`), so the agent path is untouched.
- **`window_minutes` / `max_rows` live on the Schedule, not the Connection** — the window tracks cadence (hourly wants ~60 min, daily ~1440), so one Connection backs many Schedules at different cadences. The unused slice-1 connection columns are dropped.
- **New `skipped` eval-run status.** A dataset run whose window returns no usable rows is neither success (a `completed` run with a null score corrupts trends) nor failure (a `failed` run fires false alerts every quiet hour). `skipped` is the honest third outcome; it sends no email and is excluded from trends.

## Consequences

- Adding a cloud provider = a new adapter file + its auth handling, not a schema or pipeline change.
- A multi-field/non-header credential (SigV4, GCP JSON) will need richer secret storage than the current single-Vault-secret header model — deferred with the cloud providers.
- `config jsonb` is schemaless at the DB layer; each adapter validates its own config shape in the server action (zod discriminated union) and worker.
