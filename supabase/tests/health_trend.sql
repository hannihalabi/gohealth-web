-- Execute inside a transaction and roll back. Synthetic accounts only.
create function pg_temp.ht_assert(condition boolean, label text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'Failed: %', label; end if; end $$;
create function pg_temp.ht_denied(statement text, state text, label text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'Unexpected success: %', label;
exception when others then
  if sqlstate is distinct from state then raise; end if;
end $$;
create function pg_temp.ht_claims(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'c6000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'session_id', 'c7000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'aal', 'aal1', 'amr', jsonb_build_array(jsonb_build_object('method', 'password')))::text, true);
end $$;
update clinical_private.portal_settings set mfa_required = false;
insert into auth.users(id, email, email_confirmed_at)
select ('c6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'trend-' || n || '@example.invalid', now() from generate_series(1, 3) n;
insert into auth.sessions(id, user_id)
select ('c7000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ('c6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid from generate_series(1, 3) n;
insert into clinical_private.organizations(id, name) values ('c8000000-0000-4000-8000-000000000001', 'Trend clinic');
insert into clinical_private.staff(user_id, organization_id, display_name, role) values
  ('c6000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001', 'Doctor', 'doctor'),
  ('c6000000-0000-4000-8000-000000000002', 'c8000000-0000-4000-8000-000000000001', 'Unassigned', 'doctor');
insert into clinical_private.patients(id, account_id, display_name, identity_label, identity_verified)
values ('c9000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000003', 'Trend patient', 'TREND-1', true);
insert into clinical_private.assignments(patient_id, organization_id, clinician_id)
values ('c9000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001');
-- Two resting-heart-rate samples on one day, one on another, and two overlapping sleep intervals.
insert into clinical_private.health_measurements(patient_id, source_id, kind, value, unit, start_at, end_at, source, definition, metadata)
select 'c9000000-0000-4000-8000-000000000001', gen_random_uuid(), 'resting-heart-rate', v, 'count/min', t, t, 'Synthetic', 'test', '{}'
from (values (60.0, now() - interval '2 hours'), (70.0, now() - interval '3 hours'), (50.0, now() - interval '3 days')) as x(v, t);
insert into clinical_private.health_measurements(patient_id, source_id, kind, value, unit, start_at, end_at, source, definition, metadata) values
  ('c9000000-0000-4000-8000-000000000001', gen_random_uuid(), 'sleep', null, 'interval', date_trunc('day', now()) - interval '2 days 2 hours', date_trunc('day', now()) - interval '2 days' + interval '3 hours', 'Synthetic', 'test', '{}'),
  ('c9000000-0000-4000-8000-000000000001', gen_random_uuid(), 'sleep', null, 'interval', date_trunc('day', now()) - interval '2 days' + interval '0 hours', date_trunc('day', now()) - interval '2 days' + interval '5 hours', 'Synthetic', 'test', '{}');

set local role authenticated;
select pg_temp.ht_claims(1);
select pg_temp.ht_assert((select count(*) filter (where r->>'kind' = 'resting-heart-rate') in (1, 2)
  and coalesce(sum((r->>'n')::int) filter (where r->>'kind' = 'resting-heart-rate'), 0) = 3
  and min((r->>'min')::float) filter (where r->>'kind' = 'resting-heart-rate') = 50
  and max((r->>'max')::float) filter (where r->>'kind' = 'resting-heart-rate') = 70
  from jsonb_array_elements(public.clinician_health_trend('c9000000-0000-4000-8000-000000000001', 30)->'series') r), 'daily numeric aggregates keep every sample and the extremes');
select pg_temp.ht_assert((select coalesce(sum((r->>'sum')::float) filter (where r->>'kind' = 'sleep'), 0) between 7 * 3600 - 1 and 7 * 3600 + 1
  from jsonb_array_elements(public.clinician_health_trend('c9000000-0000-4000-8000-000000000001', 30)->'series') r), 'overlapping sleep intervals are merged, 8h to 1h = 7h');
select pg_temp.ht_assert(not exists (select 1 from jsonb_array_elements(public.clinician_health_trend('c9000000-0000-4000-8000-000000000001', 1)->'series') r where r->>'kind' = 'sleep'), 'the range limits which days are returned');
select pg_temp.ht_denied($q$select public.clinician_health_trend('c9000000-0000-4000-8000-000000000001', 0)$q$, '22023', 'invalid range');
select pg_temp.ht_denied($q$select public.clinician_health_trend('c9000000-0000-4000-8000-000000000001', 1000)$q$, '22023', 'range is bounded');
-- Week and month buckets: weighted mean, mean daily total and day count, independent of where the weeks fall.
select pg_temp.ht_assert((select sum((r->>'n')::int) = 3 and sum((r->>'avg')::float * (r->>'n')::int) = 180
  and sum((r->>'sum')::float * (r->>'days')::int) = 180 and sum((r->>'days')::int) = 2
  from jsonb_array_elements(public.clinician_health_trend('c9000000-0000-4000-8000-000000000001', 365, 'week')->'series') r
  where r->>'kind' = 'resting-heart-rate'), 'weekly buckets keep every sample, weighted mean and daily totals');
select pg_temp.ht_assert((select sum((r->>'sum')::float * (r->>'days')::int) between 7 * 3600 - 1 and 7 * 3600 + 1
  from jsonb_array_elements(public.clinician_health_trend('c9000000-0000-4000-8000-000000000001', 40000, 'month')->'series') r
  where r->>'kind' = 'sleep'), 'monthly buckets keep merged sleep per night');
select pg_temp.ht_denied($q$select public.clinician_health_trend('c9000000-0000-4000-8000-000000000001', 30, 'year')$q$, '22023', 'unknown bucket');
select pg_temp.ht_denied($q$select public.clinician_health_trend('c9000000-0000-4000-8000-000000000001', 5000, 'week')$q$, '22023', 'weekly range is bounded');
select pg_temp.ht_claims(2);
select pg_temp.ht_denied($q$select public.clinician_health_trend('c9000000-0000-4000-8000-000000000001', 30)$q$, '42501', 'unassigned clinician is denied');
reset role;
set local role anon;
select pg_temp.ht_denied($q$select public.clinician_health_trend('c9000000-0000-4000-8000-000000000001', 30)$q$, '42501', 'anonymous callers are denied');
reset role;
select pg_temp.ht_assert((select count(*) from clinical_private.audit where action = 'patient.read_health_trend') = 5, 'every successful read is audited');
select 'Health trend tests passed: daily, weekly and monthly aggregates, merged sleep, range bounds, care relation, audit.' as result;
