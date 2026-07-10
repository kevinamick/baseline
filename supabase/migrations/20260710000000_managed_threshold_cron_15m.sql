-- Back the managed-threshold billing sweep off from every minute to every 15
-- minutes. The sweep (#186, ADR-0008 Meter 2) wakes the app whenever any org
-- carries un-invoiced managed spend, but the app-side billing decision only
-- acts on threshold-reached or period-ended — so a Team sitting below its
-- plan's invoicing threshold kept the cron poking (and logging) once a minute
-- for the whole period. Threshold billing doesn't need minute-level latency;
-- 15 minutes bounds the credit window just as well at 1/15th the wake-ups.
--
-- cron.schedule upserts by job name, so this reschedules the existing job.
select cron.schedule('tick-managed-threshold', '*/15 * * * *', $$ select public.tick_managed_threshold(); $$);
