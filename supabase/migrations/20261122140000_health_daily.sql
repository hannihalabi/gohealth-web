-- Long-range trends (1 year, all history) without scanning every sample.
-- health_daily holds one row per patient, metric and Swedish calendar day, kept exact by triggers:
--   numeric samples: count, total, lowest, highest (day of end_at);
--   interval samples (sleep): merged seconds per night (day after the night, same rule as before).
create table clinical_private.health_daily (
  patient_id uuid not null references clinical_private.patients on delete cascade,
  kind text not null,
  day date not null,
  n integer not null default 0,
  total double precision,
  lo double precision,
  hi double precision,
  seconds double precision,
  primary key (patient_id, kind, day)
);
create index health_daily_patient_day on clinical_private.health_daily(patient_id, day);
alter table clinical_private.health_daily enable row level security;
revoke all on clinical_private.health_daily from public, anon, authenticated;

-- Recomputes the given (patient, metric, day) keys from the source rows, using the per-metric time index.
create function clinical_private.health_daily_refresh(keys jsonb) returns void
language sql security definer set search_path = pg_catalog as $$
  delete from clinical_private.health_daily h
  using (select distinct (e->>0)::uuid patient_id, e->>1 kind, (e->>2)::date as day from jsonb_array_elements(keys) e) k
  where h.patient_id = k.patient_id and h.kind = k.kind and h.day = k.day;
  insert into clinical_private.health_daily (patient_id, kind, day, n, total, lo, hi, seconds)
  select k.patient_id, k.kind, k.day, coalesce(v.n, 0), v.total, v.lo, v.hi, i.seconds
  from (select distinct (e->>0)::uuid patient_id, e->>1 kind, (e->>2)::date as day from jsonb_array_elements(keys) e) k
  left join lateral (
    select count(*)::int n, sum(m.value) total, min(m.value) lo, max(m.value) hi
    from clinical_private.all_health_measurements m
    where m.patient_id = k.patient_id and m.kind = k.kind and m.value is not null
      and m.end_at >= (k.day::timestamp at time zone 'Europe/Stockholm')
      and m.end_at < ((k.day + 1)::timestamp at time zone 'Europe/Stockholm')
  ) v on true
  left join lateral (
    select sum(extract(epoch from upper(x) - lower(x)))::double precision seconds
    from unnest((
      select range_agg(tstzrange(m.start_at, m.end_at, '[)'))
      from clinical_private.all_health_measurements m
      where m.patient_id = k.patient_id and m.kind = k.kind and m.value is null and m.end_at > m.start_at
        and m.end_at >= (((k.day - 1)::timestamp + time '12:00') at time zone 'Europe/Stockholm')
        and m.end_at < ((k.day::timestamp + time '12:00') at time zone 'Europe/Stockholm')
    )) x
  ) i on true
  where coalesce(v.n, 0) > 0 or i.seconds is not null;
$$;

create function clinical_private.health_daily_key(value double precision, end_at timestamptz) returns date
language sql stable set search_path = pg_catalog as $$
  select case when value is null then ((end_at at time zone 'Europe/Stockholm') - interval '12 hours')::date + 1
              else (end_at at time zone 'Europe/Stockholm')::date end
$$;
create function clinical_private.health_daily_after_insert() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  perform clinical_private.health_daily_refresh(coalesce((select jsonb_agg(distinct jsonb_build_array(patient_id, kind,
    clinical_private.health_daily_key(value, end_at))) from new_rows), '[]'));
  return null;
end $$;
create function clinical_private.health_daily_after_update() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  perform clinical_private.health_daily_refresh(coalesce((select jsonb_agg(distinct jsonb_build_array(patient_id, kind,
    clinical_private.health_daily_key(value, end_at))) from (select patient_id, kind, value, end_at from old_rows
    union all select patient_id, kind, value, end_at from new_rows) r), '[]'));
  return null;
end $$;
create function clinical_private.health_daily_after_delete() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  perform clinical_private.health_daily_refresh(coalesce((select jsonb_agg(distinct jsonb_build_array(patient_id, kind,
    clinical_private.health_daily_key(value, end_at))) from old_rows), '[]'));
  return null;
end $$;
revoke all on function clinical_private.health_daily_refresh(jsonb), clinical_private.health_daily_key(double precision, timestamptz),
  clinical_private.health_daily_after_insert(), clinical_private.health_daily_after_update(),
  clinical_private.health_daily_after_delete() from public, anon, authenticated;

-- Triggers first, then the backfill: the trigger lock holds off concurrent syncs until this commits.
create trigger health_daily_insert after insert on clinical_private.health_measurements
  referencing new table as new_rows for each statement execute function clinical_private.health_daily_after_insert();
create trigger health_daily_update after update on clinical_private.health_measurements
  referencing old table as old_rows new table as new_rows for each statement execute function clinical_private.health_daily_after_update();
create trigger health_daily_delete after delete on clinical_private.health_measurements
  referencing old table as old_rows for each statement execute function clinical_private.health_daily_after_delete();
create trigger health_daily_insert after insert on clinical_private.vitals
  referencing new table as new_rows for each statement execute function clinical_private.health_daily_after_insert();
create trigger health_daily_update after update on clinical_private.vitals
  referencing old table as old_rows new table as new_rows for each statement execute function clinical_private.health_daily_after_update();
create trigger health_daily_delete after delete on clinical_private.vitals
  referencing old table as old_rows for each statement execute function clinical_private.health_daily_after_delete();

insert into clinical_private.health_daily (patient_id, kind, day, n, total, lo, hi, seconds)
select coalesce(v.patient_id, i.patient_id), coalesce(v.kind, i.kind), coalesce(v.day, i.day), coalesce(v.n, 0), v.total, v.lo, v.hi, i.seconds
from (
  select patient_id, kind, (end_at at time zone 'Europe/Stockholm')::date as day, count(*)::int n, sum(value) total, min(value) lo, max(value) hi
  from clinical_private.all_health_measurements where value is not null group by 1, 2, 3
) v
full join (
  select patient_id, kind, day, sum(extract(epoch from upper(x) - lower(x)))::double precision seconds
  from (
    select patient_id, kind, ((end_at at time zone 'Europe/Stockholm') - interval '12 hours')::date + 1 as day,
      unnest(range_agg(tstzrange(start_at, end_at, '[)'))) x
    from clinical_private.all_health_measurements where value is null and end_at > start_at group by 1, 2, 3
  ) r group by 1, 2, 3
) i on i.patient_id = v.patient_id and i.kind = v.kind and i.day = v.day;

-- Trend per day, week or month. For week and month:
--   avg = sample-weighted mean; sum = mean daily total (steps per day, sleep per night); days = days with data.
drop function public.clinician_health_trend(uuid, integer);
drop function clinical_private.health_trend(uuid, integer);
create function clinical_private.health_trend(p_patient uuid, p_days integer, p_bucket text default 'day') returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  actor uuid := clinical_private.live_actor();
  n integer;
  since date;
  result jsonb;
begin
  if not clinical_private.portal_assurance_sufficient() or not exists (
    select 1 from clinical_private.assignments a
    join clinical_private.staff s on s.user_id = a.clinician_id and s.organization_id = a.organization_id
    where a.patient_id = p_patient and a.clinician_id = actor and a.active and s.active
  ) then raise exception 'Active clinical care relation required' using errcode = '42501'; end if;
  if p_bucket is null or p_bucket not in ('day', 'week', 'month') or p_days is null or p_days < 1
    or (p_bucket = 'day' and p_days > 366) or (p_bucket = 'week' and p_days > 3700) or p_days > 40000
  then raise exception 'Invalid trend range' using errcode = '22023'; end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  since := (now() at time zone 'Europe/Stockholm')::date - (p_days - 1);

  select coalesce(jsonb_agg(to_jsonb(t) order by t.kind, t.day), '[]'::jsonb) into result from (
    select d.kind, case when p_bucket = 'day' then d.day else date_trunc(p_bucket, d.day::timestamp)::date end as day,
      sum(d.total) / sum(d.n) as avg, min(d.lo) as min, max(d.hi) as max, sum(d.total) / count(*) as sum,
      sum(d.n)::int as n, count(*)::int as days
    from clinical_private.health_daily d
    where d.patient_id = p_patient and d.day >= since and d.n > 0 group by 1, 2
    union all
    select d.kind, case when p_bucket = 'day' then d.day else date_trunc(p_bucket, d.day::timestamp)::date end,
      null::double precision, null::double precision, null::double precision, avg(d.seconds), null::int, count(*)::int
    from clinical_private.health_daily d
    where d.patient_id = p_patient and d.day >= since and d.seconds is not null group by 1, 2
  ) t;
  insert into clinical_private.audit (actor_id, patient_id, action) values (actor, p_patient, 'patient.read_health_trend');
  return jsonb_build_object('days', p_days, 'bucket', p_bucket, 'series', result);
end $$;
revoke all on function clinical_private.health_trend(uuid, integer, text) from public, anon, authenticated;
grant execute on function clinical_private.health_trend(uuid, integer, text) to authenticated;
create function public.clinician_health_trend(p_patient uuid, p_days integer default 90, p_bucket text default 'day') returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.health_trend(p_patient, p_days, p_bucket)$$;
revoke all on function public.clinician_health_trend(uuid, integer, text) from public, anon;
grant execute on function public.clinician_health_trend(uuid, integer, text) to authenticated;
