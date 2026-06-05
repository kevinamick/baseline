-- Scheduler: pg_cron is the timer, the existing eval_runs pgmq is the broker, and
-- the existing worker is the executor. See docs/adr/0003-pg-cron-scheduler-over-queue.md.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- DB-side mirror of the worker wake config (kept out of git: seed via ops / .sql, not here).
-- pg_net cannot read process env, so the tick reads the wake URL + bearer secret from here.
create table public.worker_config (
  id          smallint primary key default 1 check (id = 1),
  wake_url    text,
  wake_secret text
);
insert into public.worker_config (id) values (1) on conflict do nothing;
alter table public.worker_config enable row level security;

-- Pure timezone math: the next UTC instant strictly after p_after at which a Schedule
-- with this cadence should fire. Uses AT TIME ZONE so DST is handled automatically.
-- days_of_week / day_of_month follow isodow (1=Mon..7=Sun) and 1..28 respectively.
create or replace function public.compute_next_run_at(
  p_frequency    text,
  p_local_hour   smallint,
  p_days_of_week smallint[],
  p_day_of_month smallint,
  p_timezone     text,
  p_after        timestamptz default now()
) returns timestamptz
language plpgsql
stable
as $$
declare
  v_local      timestamp;            -- wall-clock local time of p_after
  v_cand_local timestamp;
  v_hour       int := coalesce(p_local_hour, 0);
  i            int;
  v_dow        int;
begin
  -- Hourly fires at minute :00 of every hour; tz is irrelevant at minute 0.
  if p_frequency = 'hourly' then
    return date_trunc('hour', p_after) + interval '1 hour';
  end if;

  v_local := p_after at time zone p_timezone;

  if p_frequency = 'daily' then
    v_cand_local := date_trunc('day', v_local) + make_interval(hours => v_hour);
    if v_cand_local <= v_local then
      v_cand_local := v_cand_local + interval '1 day';
    end if;
    return v_cand_local at time zone p_timezone;

  elsif p_frequency = 'weekly' then
    -- Scan today..+7 days for the soonest selected weekday whose time is still ahead.
    for i in 0..7 loop
      v_cand_local := date_trunc('day', v_local) + make_interval(days => i, hours => v_hour);
      v_dow := extract(isodow from v_cand_local)::int;
      if v_dow = any(coalesce(p_days_of_week, '{}'::smallint[])) and v_cand_local > v_local then
        return v_cand_local at time zone p_timezone;
      end if;
    end loop;
    return null;  -- no days selected

  elsif p_frequency = 'monthly' then
    v_cand_local := date_trunc('month', v_local)
                    + make_interval(days => coalesce(p_day_of_month, 1) - 1, hours => v_hour);
    if v_cand_local <= v_local then
      v_cand_local := (date_trunc('month', v_local) + interval '1 month')
                      + make_interval(days => coalesce(p_day_of_month, 1) - 1, hours => v_hour);
    end if;
    return v_cand_local at time zone p_timezone;
  end if;

  return null;
end;
$$;

-- Server action computes a Schedule's initial next_run_at via this RPC.
revoke execute on function public.compute_next_run_at(text, smallint, smallint[], smallint, text, timestamptz) from public;
grant  execute on function public.compute_next_run_at(text, smallint, smallint[], smallint, text, timestamptz) to service_role;

-- The tick: find due Schedules, spawn queued Eval Runs onto the existing pgmq,
-- recompute next_run_at, and wake the worker once if anything was enqueued.
create or replace function public.tick_schedules()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sched  record;
  v_cfg    record;
  v_run_id uuid;
  v_count  int := 0;
begin
  for v_sched in
    select *
    from public.schedules
    where enabled and next_run_at is not null and next_run_at <= now()
    order by next_run_at
    for update skip locked
    limit 100
  loop
    insert into public.eval_runs
      (created_by, rubric_id, schedule_id, eval_type, description, notification_emails)
    values
      (v_sched.created_by, v_sched.rubric_id, v_sched.id, v_sched.eval_type,
       v_sched.description, coalesce(v_sched.notification_emails, '{}'::text[]))
    returning id into v_run_id;

    -- Copy the fixed input set; agent_output is left empty for the worker to fill.
    insert into public.eval_run_rows
      (eval_run_id, row_index, user_input, agent_output, expected_output, retrieval_context)
    select v_run_id, row_index, user_input, '', expected_output, retrieval_context
    from public.schedule_inputs
    where schedule_id = v_sched.id;

    perform public.enqueue_eval_run(v_run_id);

    update public.schedules
    set last_run_at = now(),
        next_run_at = public.compute_next_run_at(
          frequency, local_hour, days_of_week, day_of_month, timezone, now()),
        updated_at  = now()
    where id = v_sched.id;

    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    select wake_url, wake_secret into v_cfg from public.worker_config where id = 1;
    if v_cfg.wake_url is not null and v_cfg.wake_url <> '' then
      perform net.http_post(
        url     => v_cfg.wake_url,
        body    => '{}'::jsonb,
        headers => case
          when coalesce(v_cfg.wake_secret, '') <> '' then
            jsonb_build_object('Content-Type', 'application/json',
                               'Authorization', 'Bearer ' || v_cfg.wake_secret)
          else '{"Content-Type":"application/json"}'::jsonb
        end
      );
    end if;
  end if;

  return v_count;
end;
$$;

revoke execute on function public.tick_schedules() from public;
grant  execute on function public.tick_schedules() to service_role;

-- Register the once-a-minute tick (idempotent across db resets).
do $$
begin
  perform cron.unschedule('tick-schedules');
exception when others then
  null;
end
$$;

select cron.schedule('tick-schedules', '* * * * *', $$ select public.tick_schedules(); $$);
