-- …or just mark it due and let pg_cron pick it up within ~1 min:
update public.schedules set next_run_at = now() where name = 'Daily support-log QA';

-- Spawn a run immediately (same thing pg_cron does every minute):
select public.tick_schedules();