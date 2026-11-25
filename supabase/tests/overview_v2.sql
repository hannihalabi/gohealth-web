-- Execute inside a transaction and roll back. Synthetic accounts only.
-- Users: 1 assigned doctor, 2 colleague doctor, 3 assigned nurse, 4 doctor in another clinic, 5 patient account.
create function pg_temp.o2_assert(condition boolean, label text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'Failed: %', label; end if; end $$;
create function pg_temp.o2_denied(statement text, state text, label text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'Unexpected success: %', label;
exception when others then
  if sqlstate is distinct from state then raise; end if;
end $$;
create function pg_temp.o2_claims(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'a6000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'session_id', 'a7000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'aal', 'aal1', 'amr', jsonb_build_array(jsonb_build_object('method', 'password')))::text, true);
end $$;
update clinical_private.portal_settings set mfa_required = false;
insert into auth.users(id, email, email_confirmed_at)
select ('a6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'overview2-' || n || '@example.invalid', now() from generate_series(1, 5) n;
insert into auth.sessions(id, user_id)
select ('a7000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ('a6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid from generate_series(1, 5) n;
insert into clinical_private.organizations(id, name) values
  ('a8000000-0000-4000-8000-000000000001', 'Overview clinic'), ('a8000000-0000-4000-8000-000000000002', 'Other clinic');
insert into clinical_private.staff(user_id, organization_id, display_name, role) values
  ('a6000000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000001', 'Dr. Assigned', 'doctor'),
  ('a6000000-0000-4000-8000-000000000002', 'a8000000-0000-4000-8000-000000000001', 'Dr. Colleague', 'doctor'),
  ('a6000000-0000-4000-8000-000000000003', 'a8000000-0000-4000-8000-000000000001', 'Nurse', 'nurse'),
  ('a6000000-0000-4000-8000-000000000004', 'a8000000-0000-4000-8000-000000000002', 'Dr. Elsewhere', 'doctor');
insert into clinical_private.patients(id, account_id, display_name, identity_label, identity_verified)
values ('a9000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000005', 'Pool patient', 'OV2-1', true);
insert into clinical_private.organization_patients(organization_id, patient_id) values ('a8000000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001');
insert into clinical_private.assignments(patient_id, organization_id, clinician_id) values
  ('a9000000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001'),
  ('a9000000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000003');
-- Resting heart rate 60 for 30 days, then 75 for the last 5 days.
insert into clinical_private.health_measurements(patient_id, source_id, kind, value, unit, start_at, end_at, source, definition, metadata)
select 'a9000000-0000-4000-8000-000000000001', gen_random_uuid(), 'resting-heart-rate', case when d < 5 then 75 else 60 end, 'count/min',
  now() - d * interval '1 day', now() - d * interval '1 day', 'Synthetic', 'test', '{}'
from generate_series(0, 34) d;
-- A past meeting 40 days ago and one in 10 days, booked with the assigned doctor.
insert into clinical_private.booking_requests(organization_id, patient_id, clinician_id, visit_type, status, starts_at, ends_at, booked_at) values
  ('a8000000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', 'video', 'booked',
   now() - interval '40 days', now() - interval '40 days' + interval '20 minutes', now() - interval '45 days'),
  ('a8000000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', 'phone', 'booked',
   now() + interval '10 days', now() + interval '10 days' + interval '20 minutes', now());
set local role authenticated;

-- A published lab value above its reference range is a lab deviation with the range.
select pg_temp.o2_claims(1);
create temp table o2_rec as select public.clinician_save_record('a9000000-0000-4000-8000-000000000001', 'lab',
  jsonb_build_object('title', 'Sköldkörtel', 'source', 'Synthetic', 'sampledAt', '2026-11-20T08:00:00Z', 'comment', '',
    'observations', jsonb_build_array(jsonb_build_object('code', 'tsh', 'name', 'TSH', 'value', '7.5', 'unit', 'mIE/L', 'comparator', '=', 'referenceText', '',
      'referenceLow', 0.4, 'referenceHigh', 4.0))), null, 0, null, '') as r;
select public.clinician_publish_record((select (r->>'id')::uuid from o2_rec), (select (r->>'revision')::int from o2_rec));
create temp table o2_ov as select public.clinician_overview() as o;
select pg_temp.o2_assert((select count(*) = 1 from o2_ov, jsonb_array_elements(o->'deviations') d
  where d->>'category' = 'lab' and d->'data'->>'direction' = 'high' and (d->'data'->>'high')::numeric = 4.0 and (d->'data'->>'value')::numeric = 7.5
    and d->>'key' like 'lab:%:tsh' and d->>'reviewed_at' is null), 'the high TSH is a lab deviation with its range');
select pg_temp.o2_assert((select count(*) = 1 from o2_ov, jsonb_array_elements(o->'deviations') d
  where d->>'category' = 'vitals' and d->>'rule' = 'resting-heart-rate' and d->>'key' like 'resting-heart-rate:____-__'
    and (d->'data'->>'base')::numeric = 60), 'the heart rate trend carries recent and base values');
select pg_temp.o2_assert((select (o->'counts'->>'review')::int = 2 from o2_ov), 'two results wait for review');

-- Follow-up: last meeting 40 days ago is due (30 days), the next is booked; the agenda shows my meeting.
select pg_temp.o2_assert((select f->>'next_visit_type' = 'phone' and (f->>'due_on')::date < current_date and f->>'last_at' is not null
  from o2_ov, jsonb_array_elements(o->'followups') f), 'the follow-up shows last, next and due date');
select pg_temp.o2_assert((select count(*) >= 1 from o2_ov, jsonb_array_elements(o->'agenda') a where a->>'display_name' = 'Pool patient'),
  'the booked meeting is on the agenda');

-- Review: a doctor marks it, the colleague sees who; a nurse and another clinic cannot.
select public.clinician_review_deviation(jsonb_build_object('patient', 'a9000000-0000-4000-8000-000000000001',
  'key', (select d->>'key' from o2_ov, jsonb_array_elements(o->'deviations') d where d->>'category' = 'lab')));
select pg_temp.o2_assert((public.clinician_overview()->'counts'->>'review')::int = 1, 'one left to review');
select pg_temp.o2_claims(3);
select pg_temp.o2_denied($q$select public.clinician_review_deviation(jsonb_build_object('patient', 'a9000000-0000-4000-8000-000000000001', 'key', 'hrv:2026-48'))$q$,
  '42501', 'a nurse cannot mark results reviewed');
select pg_temp.o2_claims(4);
select pg_temp.o2_denied($q$select public.clinician_review_deviation(jsonb_build_object('patient', 'a9000000-0000-4000-8000-000000000001', 'key', 'hrv:2026-48'))$q$,
  '42501', 'another clinic cannot');
select pg_temp.o2_claims(5);
select pg_temp.o2_denied($q$select public.clinician_review_deviation(jsonb_build_object('patient', 'a9000000-0000-4000-8000-000000000001', 'key', 'hrv:2026-48'))$q$,
  '42501', 'the patient cannot');
select pg_temp.o2_claims(1);
select pg_temp.o2_assert((select d->>'reviewed_by' = 'Dr. Assigned' and d->>'reviewed_at' is not null
  from jsonb_array_elements(public.clinician_overview()->'deviations') d where d->>'category' = 'lab'), 'the review names the doctor');
select public.clinician_review_deviation(jsonb_build_object('patient', 'a9000000-0000-4000-8000-000000000001', 'undo', true,
  'key', (select d->>'key' from o2_ov, jsonb_array_elements(o->'deviations') d where d->>'category' = 'lab')));
select pg_temp.o2_assert((public.clinician_overview()->'counts'->>'review')::int = 2, 'the mark can be taken back');
select pg_temp.o2_denied($q$select public.clinician_review_deviation(jsonb_build_object('patient', 'a9000000-0000-4000-8000-000000000001', 'key', ''))$q$,
  '22023', 'a key is required');
reset role;
select pg_temp.o2_assert((select count(*) filter (where action = 'deviation.review') = 1 and count(*) filter (where action = 'deviation.unreview') = 1
  from clinical_private.audit where patient_id = 'a9000000-0000-4000-8000-000000000001'), 'reviews are audited');
select 'Overview v2 tests passed: lab deviations with range, trend values, review by doctors only, follow-up schedule, agenda, audit.' as result;
