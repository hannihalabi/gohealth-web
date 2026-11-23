-- Execute inside a transaction and roll back. Synthetic accounts only.
-- Users: 1 assigned doctor, 2 unassigned doctor, 3 unassigned nurse, 4 doctor in another clinic, 5 administrator, 6 patient account.
create function pg_temp.ov_assert(condition boolean, label text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'Failed: %', label; end if; end $$;
create function pg_temp.ov_denied(statement text, state text, label text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'Unexpected success: %', label;
exception when others then
  if sqlstate is distinct from state then raise; end if;
end $$;
create function pg_temp.ov_claims(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'd6000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'session_id', 'd7000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'aal', 'aal1', 'amr', jsonb_build_array(jsonb_build_object('method', 'password')))::text, true);
end $$;
update clinical_private.portal_settings set mfa_required = false;
insert into auth.users(id, email, email_confirmed_at)
select ('d6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'overview-' || n || '@example.invalid', now() from generate_series(1, 6) n;
insert into auth.sessions(id, user_id)
select ('d7000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ('d6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid from generate_series(1, 6) n;
insert into clinical_private.organizations(id, name) values
  ('d8000000-0000-4000-8000-000000000001', 'Overview clinic'), ('d8000000-0000-4000-8000-000000000002', 'Other clinic');
insert into clinical_private.staff(user_id, organization_id, display_name, role) values
  ('d6000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001', 'Dr. Assigned', 'doctor'),
  ('d6000000-0000-4000-8000-000000000002', 'd8000000-0000-4000-8000-000000000001', 'Dr. Colleague', 'doctor'),
  ('d6000000-0000-4000-8000-000000000003', 'd8000000-0000-4000-8000-000000000001', 'Nurse', 'nurse'),
  ('d6000000-0000-4000-8000-000000000004', 'd8000000-0000-4000-8000-000000000002', 'Dr. Elsewhere', 'doctor');
insert into clinical_private.administrators(user_id, organization_id, display_name) values
  ('d6000000-0000-4000-8000-000000000005', 'd8000000-0000-4000-8000-000000000001', 'Admin');
insert into clinical_private.patients(id, account_id, display_name, identity_label, identity_verified)
values ('d9000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000006', 'Pool patient', 'OVERVIEW-1', true);
insert into clinical_private.organization_patients(organization_id, patient_id) values ('d8000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001');
insert into clinical_private.assignments(patient_id, organization_id, clinician_id)
values ('d9000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001');
-- Resting heart rate 60 for 30 days, then 75 for the last 5 days; one low oxygen reading.
insert into clinical_private.health_measurements(patient_id, source_id, kind, value, unit, start_at, end_at, source, definition, metadata)
select 'd9000000-0000-4000-8000-000000000001', gen_random_uuid(), 'resting-heart-rate', case when d < 5 then 75 else 60 end, 'count/min',
  now() - d * interval '1 day', now() - d * interval '1 day', 'Synthetic', 'test', '{}'
from generate_series(0, 34) d;
insert into clinical_private.health_measurements(patient_id, source_id, kind, value, unit, start_at, end_at, source, definition, metadata)
values ('d9000000-0000-4000-8000-000000000001', gen_random_uuid(), 'oxygen', 89, '%', now() - interval '1 day', now() - interval '1 day', 'Synthetic', 'test', '{}');

-- Access: every doctor in the clinic, nurses by assignment, nobody from another clinic.
select pg_temp.ov_assert(clinical_private.care_organization('d6000000-0000-4000-8000-000000000002', 'd9000000-0000-4000-8000-000000000001') = 'd8000000-0000-4000-8000-000000000001', 'an unassigned doctor in the clinic has access');
select pg_temp.ov_assert(clinical_private.care_organization('d6000000-0000-4000-8000-000000000003', 'd9000000-0000-4000-8000-000000000001') is null, 'an unassigned nurse has no access');
select pg_temp.ov_assert(clinical_private.care_organization('d6000000-0000-4000-8000-000000000004', 'd9000000-0000-4000-8000-000000000001') is null, 'a doctor from another clinic has no access');
set local role authenticated;
select pg_temp.ov_claims(2);
select pg_temp.ov_assert(public.clinician_patient('d9000000-0000-4000-8000-000000000001')->'patient'->>'display_name' = 'Pool patient', 'the colleague opens the journal');
select pg_temp.ov_assert((public.clinician_health_trend('d9000000-0000-4000-8000-000000000001', 30)->>'days')::int = 30, 'the colleague reads the trend');
select pg_temp.ov_assert((select bool_and((r->>'can_open')::boolean and not (r->>'assigned_to_me')::boolean)
  from jsonb_array_elements(public.clinician_patient_directory('', 'all')) r), 'the directory marks the patient as openable but not assigned');
select pg_temp.ov_claims(3);
select pg_temp.ov_denied($q$select public.clinician_patient('d9000000-0000-4000-8000-000000000001')$q$, '42501', 'unassigned nurse is denied');
select pg_temp.ov_assert((select bool_and(not (r->>'can_open')::boolean) from jsonb_array_elements(public.clinician_patient_directory('', 'all')) r), 'the directory locks the patient for the nurse');
select pg_temp.ov_claims(4);
select pg_temp.ov_denied($q$select public.clinician_health_trend('d9000000-0000-4000-8000-000000000001', 30)$q$, '42501', 'other clinic is denied');

-- Unsigned work: the colleague's own draft for a patient outside the pool, and the assigned doctor's queue.
select pg_temp.ov_claims(2);
select public.clinician_save_record('d9000000-0000-4000-8000-000000000001', 'imaging',
  jsonb_build_object('title', 'Colleague MR', 'source', 'Synthetic', 'sampledAt', '2026-01-01T12:00:00Z', 'comment', '',
    'modality', 'MR', 'bodyPart', 'Synthetic', 'conclusion', 'Synthetic', 'studyId', ''), null, 0, null, '');
select pg_temp.ov_assert((public.clinician_overview()->'counts'->>'unsigned')::int = 1, 'the author sees the own draft as unsigned');
select pg_temp.ov_assert((select count(*) = 1 from jsonb_array_elements(public.clinician_pending_attestations())), 'the author sees the own draft in the attestation queue');
select pg_temp.ov_claims(1);
select pg_temp.ov_assert((public.clinician_overview()->'counts'->>'unsigned')::int = 1, 'the assigned doctor sees the draft for the pool patient');
select pg_temp.ov_assert((public.clinician_overview()->'counts'->>'assigned')::int = 1 and (public.clinician_overview()->'counts'->>'clinic')::int = 1, 'patient counts');

-- Deviations: only in the assigned doctor's pool, with the numbers.
select pg_temp.ov_assert((select count(*) = 1 from jsonb_array_elements(public.clinician_overview()->'deviations') d
  where d->>'rule' = 'resting-heart-rate' and d->>'detail' like '7_ slag/min senaste 7 dagarna mot 60 slag/min tidigare'), 'rising resting heart rate is found');
select pg_temp.ov_assert((select count(*) = 1 from jsonb_array_elements(public.clinician_overview()->'deviations') d
  where d->>'rule' = 'oxygen' and d->>'severity' = 'high'), 'oxygen below 90 is high');
select pg_temp.ov_claims(2);
select pg_temp.ov_assert(public.clinician_overview()->'deviations' = '[]'::jsonb, 'a doctor without the patient in the pool sees no deviations');

-- Announcements from the administrator.
select pg_temp.ov_claims(5);
select public.clinician_announcements('d8000000-0000-4000-8000-000000000001', 'post', '{"title":"Influensavaccin","body":"Vaccinationen startar måndag."}');
select public.clinician_announcements('d8000000-0000-4000-8000-000000000001', 'post', jsonb_build_object('title', 'Gammal', 'body', 'Utgår', 'expires_at', now() + interval '1 hour'));
select pg_temp.ov_denied($q$select public.clinician_announcements('d8000000-0000-4000-8000-000000000001', 'post', '{"title":" ","body":"x"}')$q$, '22023', 'title is required');
select pg_temp.ov_claims(1);
select pg_temp.ov_assert((select count(*) = 2 from jsonb_array_elements(public.clinician_overview()->'announcements')), 'staff see live announcements');
select pg_temp.ov_denied($q$select public.clinician_announcements('d8000000-0000-4000-8000-000000000001', 'post', '{"title":"x","body":"y"}')$q$, '42501', 'staff cannot post');
select pg_temp.ov_claims(4);
select pg_temp.ov_assert(public.clinician_overview()->'announcements' = '[]'::jsonb, 'another clinic does not see them');
select pg_temp.ov_claims(5);
select public.clinician_announcements('d8000000-0000-4000-8000-000000000001', 'archive', jsonb_build_object('id', a->>'id'))
from jsonb_array_elements(public.clinician_announcements('d8000000-0000-4000-8000-000000000001')) a where a->>'title' = 'Gammal';
select pg_temp.ov_claims(1);
select pg_temp.ov_assert((select count(*) = 1 from jsonb_array_elements(public.clinician_overview()->'announcements')), 'archived announcements disappear');

-- Consultations between doctors in the clinic.
select pg_temp.ov_claims(1);
select pg_temp.ov_assert((select count(*) = 1 and bool_and(c->>'display_name' = 'Dr. Colleague') from jsonb_array_elements(public.clinician_consultation('colleagues')) c), 'colleagues are the other doctors in the clinic');
select pg_temp.ov_denied($q$select public.clinician_consultation('send', '{"patient":"d9000000-0000-4000-8000-000000000001","to":"d6000000-0000-4000-8000-000000000003","message":"Hej"}')$q$, '22023', 'nurses are not consultation recipients');
select pg_temp.ov_denied($q$select public.clinician_consultation('send', '{"patient":"d9000000-0000-4000-8000-000000000001","to":"d6000000-0000-4000-8000-000000000004","message":"Hej"}')$q$, '22023', 'doctors in another clinic are not recipients');
select pg_temp.ov_denied($q$select public.clinician_consultation('send', '{"patient":"d9000000-0000-4000-8000-000000000001","to":"d6000000-0000-4000-8000-000000000002","message":"  "}')$q$, '22023', 'a message is required');
select public.clinician_consultation('send', '{"patient":"d9000000-0000-4000-8000-000000000001","to":"d6000000-0000-4000-8000-000000000002","message":"Stigande vilopuls, vad tror du?"}');
select pg_temp.ov_claims(2);
select pg_temp.ov_assert((public.clinician_overview()->'counts'->>'consultations')::int = 1, 'the colleague has one open consultation');
select pg_temp.ov_assert((select c->>'direction' = 'in' and c->>'from_name' = 'Dr. Assigned' and c->>'display_name' = 'Pool patient'
  from jsonb_array_elements(public.clinician_overview()->'consultations') c), 'the consultation names sender and patient');
select public.clinician_consultation('reply', jsonb_build_object('id', c->>'id', 'reply', 'Följ upp med EKG.'))
from jsonb_array_elements(public.clinician_overview()->'consultations') c;
select pg_temp.ov_claims(3);
select pg_temp.ov_denied($q$select public.clinician_consultation('send', '{"patient":"d9000000-0000-4000-8000-000000000001","to":"d6000000-0000-4000-8000-000000000002","message":"Hej"}')$q$, '42501', 'a nurse without access cannot send about the patient');
select pg_temp.ov_claims(1);
select pg_temp.ov_assert((select c->>'status' = 'answered' and c->>'reply' = 'Följ upp med EKG.' and c->>'direction' = 'out'
  from jsonb_array_elements(public.clinician_overview()->'consultations') c), 'the sender sees the reply');
select public.clinician_consultation('close', jsonb_build_object('id', c->>'id')) from jsonb_array_elements(public.clinician_overview()->'consultations') c;
select pg_temp.ov_assert(public.clinician_overview()->'consultations' = '[]'::jsonb, 'closed consultations leave the overview');
reset role;
select pg_temp.ov_assert((select count(*) = 3 from clinical_private.audit where action like 'consultation.%'
  and patient_id = 'd9000000-0000-4000-8000-000000000001'), 'every consultation step is audited with the patient');
set local role anon;
select pg_temp.ov_denied($q$select public.clinician_overview()$q$, '42501', 'anonymous callers are denied');
reset role;
select 'Clinician overview tests passed: clinic-wide doctor access, nurse and clinic isolation, unsigned work, deviations, announcements, consultations, audit.' as result;
