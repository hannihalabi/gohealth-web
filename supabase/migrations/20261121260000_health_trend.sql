-- Daily trend for every shared health metric, for the clinician's trend view.
-- Numeric metrics return daily average, minimum, maximum, sum and sample count.
-- Interval metrics (sleep) return the merged duration per night, so overlapping intervals count once.
create function clinical_private.health_trend(p_patient uuid, p_days integer) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  actor uuid := clinical_private.live_actor();
  n integer;
  since timestamptz;
  result jsonb;
begin
  if not clinical_private.portal_assurance_sufficient() or not exists (
    select 1 from clinical_private.assignments a
    join clinical_private.staff s on s.user_id = a.clinician_id and s.organization_id = a.organization_id
    where a.patient_id = p_patient and a.clinician_id = actor and a.active and s.active
  ) then raise exception 'Active clinical care relation required' using errcode = '42501'; end if;
  if p_days is null or p_days not between 1 and 366 then raise exception 'Invalid trend range' using errcode = '22023'; end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  since := ((date_trunc('day', now() at time zone 'Europe/Stockholm')) - (p_days - 1) * interval '1 day') at time zone 'Europe/Stockholm';

  select coalesce(jsonb_agg(to_jsonb(t) order by t.kind, t.day), '[]'::jsonb) into result from (
    select m.kind, (m.end_at at time zone 'Europe/Stockholm')::date as day,
      avg(m.value) as avg, min(m.value) as min, max(m.value) as max, sum(m.value) as sum, count(*)::int as n
    from clinical_private.all_health_measurements m
    where m.patient_id = p_patient and m.value is not null and m.end_at >= since
    group by m.kind, (m.end_at at time zone 'Europe/Stockholm')::date
    union all
    select s.kind, s.night + 1 as day, null::double precision, null::double precision, null::double precision,
      (select sum(extract(epoch from upper(x) - lower(x))) from unnest(s.spans) x)::double precision, null::int
    from (
      select i.kind, i.night, range_agg(tstzrange(i.start_at, i.end_at, '[)')) as spans
      from (
        select m.kind, ((m.end_at at time zone 'Europe/Stockholm') - interval '12 hours')::date as night, m.start_at, m.end_at
        from clinical_private.all_health_measurements m
        where m.patient_id = p_patient and m.value is null and m.end_at >= since and m.end_at > m.start_at
      ) i group by i.kind, i.night
    ) s
  ) t;
  insert into clinical_private.audit (actor_id, patient_id, action) values (actor, p_patient, 'patient.read_health_trend');
  return jsonb_build_object('days', p_days, 'series', result);
end $$;
revoke all on function clinical_private.health_trend(uuid, integer) from public, anon, authenticated;
grant execute on function clinical_private.health_trend(uuid, integer) to authenticated;
create function public.clinician_health_trend(p_patient uuid, p_days integer default 90) returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.health_trend(p_patient, p_days)$$;
revoke all on function public.clinician_health_trend(uuid, integer) from public, anon;
grant execute on function public.clinician_health_trend(uuid, integer) to authenticated;
