-- Point the pg_cron-called internal-route URLs at the canonical www host.
--
-- baselinelab.ai now 308-redirects to www.baselinelab.ai (host canonicalization,
-- 2026-07-10). pg_net follows the redirect but drops the Authorization header
-- across it, so tick_managed_threshold and tick_retention were reaching the app
-- unauthenticated and failing closed with 401 (the managed-threshold sweep every
-- 15 minutes since 13:00 UTC that day, retention nightly).
--
-- worker_config is populated per environment, so this rewrites rather than
-- assigns: replace() no-ops wherever the URLs don't use the apex host (local,
-- e2e, staging), and re-running it is a no-op everywhere. wake_url points at
-- the Fly worker directly and is unaffected.
update worker_config
set managed_threshold_url = replace(managed_threshold_url, '://baselinelab.ai/', '://www.baselinelab.ai/'),
    retention_url         = replace(retention_url, '://baselinelab.ai/', '://www.baselinelab.ai/')
where id = 1;
