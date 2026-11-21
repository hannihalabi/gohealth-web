-- Execute inside a transaction and roll back. Synthetic accounts only.
create function pg_temp.an_assert(condition boolean, label text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'Failed: %', label; end if; end $$;
create function pg_temp.an_denied(statement text, state text, label text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'Unexpected success: %', label;
exception when others then
  if sqlstate is distinct from state then raise; end if;
end $$;
create function pg_temp.an_claims(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'a6000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'session_id', 'a7000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'aal', 'aal1', 'amr', jsonb_build_array(jsonb_build_object('method', 'password')))::text, true);
end $$;
create function pg_temp.an_payload(title text) returns jsonb language sql as $$
  select jsonb_build_object('title', title, 'source', 'Synthetic', 'sampledAt', '2025-01-01T12:00:00Z', 'comment', '',
    'modality', 'MR', 'bodyPart', 'Synthetic', 'conclusion', 'Synthetic', 'studyId', '')
$$;
update clinical_private.portal_settings set mfa_required = false;
insert into auth.users(id, email, email_confirmed_at)
select ('a6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'annul-' || n || '@example.invalid', now() from generate_series(1, 4) n;
insert into auth.sessions(id, user_id)
select ('a7000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ('a6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid from generate_series(1, 4) n;
insert into clinical_private.organizations(id, name) values ('a8000000-0000-4000-8000-000000000001', 'Annul clinic');
insert into clinical_private.staff(user_id, organization_id, display_name, role) values
  ('a6000000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000001', 'Doctor', 'doctor'),
  ('a6000000-0000-4000-8000-000000000002', 'a8000000-0000-4000-8000-000000000001', 'Nurse', 'nurse'),
  ('a6000000-0000-4000-8000-000000000003', 'a8000000-0000-4000-8000-000000000001', 'Unassigned doctor', 'doctor');
insert into clinical_private.patients(id, account_id, display_name, identity_label, identity_verified)
values ('a9000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000004', 'Synthetic patient', 'ANNUL-1', true);
insert into clinical_private.assignments(patient_id, organization_id, clinician_id) values
  ('a9000000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001'),
  ('a9000000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000002');
create temp table an_fixture (label text primary key, value jsonb);
grant select, insert on an_fixture to authenticated;

set local role authenticated;
select pg_temp.an_claims(1);
insert into an_fixture select 'published', public.clinician_save_record('a9000000-0000-4000-8000-000000000001', 'imaging', pg_temp.an_payload('Published MR'), null, 0, null, '');
select public.clinician_publish_record((value->>'id')::uuid, 1) from an_fixture where label = 'published';
select pg_temp.an_claims(2);
insert into an_fixture select 'nurse_draft', public.clinician_save_record('a9000000-0000-4000-8000-000000000001', 'imaging', pg_temp.an_payload('Draft MR'), null, 0, null, '');
select pg_temp.an_claims(4);
select pg_temp.an_assert(exists (select 1 from jsonb_array_elements(public.gohealth_patient_data()->'records') r where r->'payload'->>'title' = 'Published MR'), 'patient sees the published examination');

-- The attestation queue shows every waiting draft to the assigned care team, and to nobody else.
select pg_temp.an_claims(1);
select pg_temp.an_assert((select count(*) = 1 and bool_and(r->>'created_by_name' = 'Nurse' and r->'payload'->>'title' = 'Draft MR' and (r->>'identity_verified')::boolean)
  from jsonb_array_elements(public.clinician_pending_attestations()) r), 'the doctor sees the nurse draft waiting for attestation');
select pg_temp.an_claims(3);
select pg_temp.an_assert(public.clinician_pending_attestations() = '[]'::jsonb, 'an unassigned doctor sees no waiting drafts');
select pg_temp.an_claims(4);
select pg_temp.an_assert(public.clinician_pending_attestations() = '[]'::jsonb, 'a patient account sees no waiting drafts');
select pg_temp.an_claims(3);
select pg_temp.an_denied(format('select public.clinician_annul_record(%L, ''Fel patient'', ''Ta bort'')', value->>'id'), '42501', 'unassigned clinician cannot remove') from an_fixture where label = 'published';
select pg_temp.an_claims(2);
select pg_temp.an_denied(format('select public.clinician_annul_record(%L, ''Fel patient'', ''Ta bort'')', value->>'id'), '42501', 'a nurse cannot remove a published record') from an_fixture where label = 'published';
select pg_temp.an_claims(1);
select pg_temp.an_denied(format('select public.clinician_annul_record(%L, ''Fel patient'', ''ta bort'')', value->>'id'), '22023', 'the confirmation word must match') from an_fixture where label = 'published';
select pg_temp.an_denied(format('select public.clinician_annul_record(%L, ''  '', ''Ta bort'')', value->>'id'), '22023', 'a reason is required') from an_fixture where label = 'published';
select pg_temp.an_assert((public.clinician_annul_record((value->>'id')::uuid, 'Fel patient', 'Ta bort')->>'ok')::boolean, 'a doctor can remove a published examination') from an_fixture where label = 'published';
select pg_temp.an_assert((public.clinician_annul_record((value->>'id')::uuid, 'Fel patient', 'Ta bort')->>'ok')::boolean, 'removal can be repeated safely') from an_fixture where label = 'published';
select pg_temp.an_assert((select r->>'annulment_reason' = 'Fel patient' and r->>'annulled_at' is not null and r->>'superseded_at' is not null
  from jsonb_array_elements(public.clinician_patient('a9000000-0000-4000-8000-000000000001')->'records') r where r->>'id' = a.value->>'id'),
  'the care team sees the removal reason') from an_fixture a where label = 'published';
select pg_temp.an_claims(4);
select pg_temp.an_assert(not exists (select 1 from jsonb_array_elements(public.gohealth_patient_data()->'records') r where r->'payload'->>'title' = 'Published MR'), 'the patient no longer sees a removed examination');
select pg_temp.an_claims(2);
select pg_temp.an_assert((public.clinician_annul_record((value->>'id')::uuid, 'Skapad av misstag', 'Ta bort')->>'ok')::boolean, 'a nurse can remove their own draft') from an_fixture where label = 'nurse_draft';
select pg_temp.an_assert(public.clinician_pending_attestations() = '[]'::jsonb, 'a removed draft leaves the attestation queue');
reset role;
select pg_temp.an_assert((select count(*) = 2 from clinical_private.audit where action = 'record.annul'), 'each removal is audited once');
select pg_temp.an_denied('update clinical_private.records set payload = payload || ''{"title":"Changed"}''::jsonb where annulled_at is not null and status = ''published''', '42501', 'a removed published record is still immutable');
select 'Record removal and attestation queue tests passed: doctor and draft rules, confirmation word, reason, patient visibility, queue scope, audit and immutability.' as result;
