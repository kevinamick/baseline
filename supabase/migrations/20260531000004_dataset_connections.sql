-- Slice 2: dataset-kind Connections. A dataset Connection reads complete historical
-- rows (input + output) from where the customer already logs traffic, via a per-provider
-- adapter (custom HTTP or PostHog). See docs/adr/0004-dataset-connections-provider-adapters.md.

-- Provider-specific read config lives here; shared fields stay typed columns.
--   custom  dataset: { "field_map": { "user_input": "...", "agent_output": "...", ... } }
--   posthog dataset: { "project_id": "...", "hogql": "SELECT ... AS user_input, ..." }
--   agent:           null
-- response_path is reused as the universal "path to the data in the response":
--   agent = value path, custom = rows-array path, posthog = 'results'.
alter table public.connections
  add column config jsonb;

-- window_minutes / max_rows were premature here (never read) — they describe how much
-- history a *Schedule* pulls per fire, which tracks cadence, so they move to schedules.
alter table public.connections
  drop column if exists max_rows,
  drop column if exists window_minutes;

-- Dataset sampling controls: how far back to read and how many rows to score per fire.
-- Nullable; only meaningful for dataset-kind Schedules.
alter table public.schedules
  add column window_minutes int check (window_minutes is null or window_minutes > 0),
  add column max_rows       int check (max_rows is null or max_rows > 0);

-- A dataset run whose window yields no usable rows is neither success nor failure:
-- 'completed' with a null score corrupts trends; 'failed' fires false alerts every
-- quiet hour. 'skipped' is the honest third outcome (no email, excluded from trends).
alter type public.eval_run_status add value if not exists 'skipped';
