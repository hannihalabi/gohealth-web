-- Execute inside a transaction and roll back. Synthetic accounts only.
create function pg_temp.pd_assert(condition boolean, label text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'Failed: %', label; end if; end $$;
create function pg_temp.pd_denied(statement text, state text, label text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'Unexpected success: %', label;
exception when others then
  if sqlstate is distinct from state then raise; end if;
end $$;
create function pg_temp.pd_claims(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'd6000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'session_id', 'd7000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'aal', 'aal1', 'amr', jsonb_build_array(jsonb_build_object('method', 'password')))::text, true);
end $$;
update clinical_private.portal_settings set mfa_required = false;
insert into auth.users(id, email, email_confirmed_at)
select ('d6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'directory-' || n || '@example.invalid', now() from generate_series(1, 4) n;
insert into auth.sessions(id, user_id)
select ('d7000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ('d6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid from generate_series(1, 4) n;
insert into clinical_private.organizations(id, name) values ('d8000000-0000-4000-8000-000000000001', 'Clinic A'), ('d8000000-0000-4000-8000-000000000002', 'Clinic B');
insert into clinical_private.staff(user_id, organization_id, display_name, role) values
  ('d6000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001', 'Doctor A', 'doctor'),
  ('d6000000-0000-4000-8000-000000000002', 'd8000000-0000-4000-8000-000000000001', 'Nurse B', 'nurse'),
  ('d6000000-0000-4000-8000-000000000003', 'd8000000-0000-4000-8000-000000000001', 'Doctor C', 'doctor');
insert into clinical_private.patients(id, display_name, identity_label, identity_verified) values
  ('d9000000-0000-4000-8000-000000000001', 'Anna Ett', 'DIR-1', true),
  ('d9000000-0000-4000-8000-000000000002', 'Berit Två', 'DIR-2', true),
  ('d9000000-0000-4000-8000-000000000003', 'Cecilia Tre', 'DIR-3', true),
  ('d9000000-0000-4000-8000-000000000004', 'Dora Annan klinik', 'DIR-4', true);
insert into clinical_private.organization_patients(organization_id, patient_id) values
  ('d8000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001'),
  ('d8000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000002'),
  ('d8000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000003'),
  ('d8000000-0000-4000-8000-000000000002', 'd9000000-0000-4000-8000-000000000004');
insert into clinical_private.assignments(patient_id, organization_id, clinician_id) values
  ('d9000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001'),
  ('d9000000-0000-4000-8000-000000000002', 'd8000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000002'),
  ('d9000000-0000-4000-8000-000000000002', 'd8000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000003');

set local role authenticated;
select pg_temp.pd_claims(1);
select pg_temp.pd_assert((select count(*) = 1 and bool_and(r->>'display_name' = 'Anna Ett' and (r->>'assigned_to_me')::boolean and r->'doctors' = '["Doctor A"]'::jsonb)
  from jsonb_array_elements(public.clinician_patient_directory('', 'mine')) r), 'mine lists only my patients with their doctor');
select pg_temp.pd_assert((select count(*) = 3 from jsonb_array_elements(public.clinician_patient_directory('', 'all')) r), 'all lists every patient in my clinic and none from another');
select pg_temp.pd_assert((select r->'doctors' = '["Doctor C"]'::jsonb and not (r->>'assigned_to_me')::boolean
  from jsonb_array_elements(public.clinician_patient_directory('', 'all')) r where r->>'display_name' = 'Berit Två'), 'doctors exclude nurses and unassigned patients are flagged');
select pg_temp.pd_assert((select r->'doctors' = '[]'::jsonb from jsonb_array_elements(public.clinician_patient_directory('', 'all')) r where r->>'display_name' = 'Cecilia Tre'), 'a patient without a doctor has an empty list');
select pg_temp.pd_assert((select count(*) = 1 from jsonb_array_elements(public.clinician_patient_directory('cecilia', 'all')) r), 'name search works');
select pg_temp.pd_assert((select count(*) = 1 from jsonb_array_elements(public.clinician_patient_directory('DIR-2', 'all')) r), 'exact identity search works');
select pg_temp.pd_denied($q$select public.clinician_patient_directory('', 'everything')$q$, '22023', 'unknown scope');
select pg_temp.pd_claims(2);
select pg_temp.pd_assert((select count(*) = 1 and (min(r->>'display_name') = 'Berit Två') from jsonb_array_elements(public.clinician_patient_directory('', 'mine')) r), 'a nurse sees their own patients');
select pg_temp.pd_claims(4);
select pg_temp.pd_assert(public.clinician_patient_directory('', 'all') = '[]'::jsonb, 'an account without staff access sees nobody');
reset role;
set local role anon;
select pg_temp.pd_denied($q$select public.clinician_patient_directory('', 'all')$q$, '42501', 'anonymous callers are denied');
reset role;
select 'Patient directory tests passed: mine and all, assigned doctors, clinic scope, search and access.' as result;
