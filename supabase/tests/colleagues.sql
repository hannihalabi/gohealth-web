-- Execute inside a transaction and roll back. Synthetic accounts only.
-- Users: 1 doctor, 2 nurse in the doctor's team, 3 doctor in another clinic, 4 inactive doctor, 5 patient account,
-- 6 psychologist without a team.
create function pg_temp.co_assert(condition boolean, label text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'Failed: %', label; end if; end $$;
create function pg_temp.co_denied(statement text, state text, label text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'Unexpected success: %', label;
exception when others then
  if sqlstate is distinct from state then raise; end if;
end $$;
create function pg_temp.co_claims(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'b6000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'session_id', 'b7000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'aal', 'aal1', 'amr', jsonb_build_array(jsonb_build_object('method', 'password')))::text, true);
end $$;
create function pg_temp.co_list() returns jsonb language sql as $$select public.clinician_colleagues()->'colleagues'$$;
create function pg_temp.co_person(n integer) returns jsonb language sql as $$
  select c from jsonb_array_elements(pg_temp.co_list()) c where c->>'id' = 'b6000000-0000-4000-8000-' || lpad(n::text, 12, '0')
$$;
update clinical_private.portal_settings set mfa_required = false;
insert into auth.users(id, email, email_confirmed_at)
select ('b6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'colleague-' || n || '@example.invalid', now() from generate_series(1, 6) n;
insert into auth.sessions(id, user_id)
select ('b7000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ('b6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid from generate_series(1, 6) n;
insert into clinical_private.organizations(id, name) values
  ('b8000000-0000-4000-8000-000000000001', 'Colleague clinic'), ('b8000000-0000-4000-8000-000000000002', 'Other clinic');
insert into clinical_private.staff(user_id, organization_id, display_name, role, active) values
  ('b6000000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000001', 'Dr. Lead', 'doctor', true),
  ('b6000000-0000-4000-8000-000000000002', 'b8000000-0000-4000-8000-000000000001', 'Nurse Team', 'nurse', true),
  ('b6000000-0000-4000-8000-000000000003', 'b8000000-0000-4000-8000-000000000002', 'Dr. Elsewhere', 'doctor', true),
  ('b6000000-0000-4000-8000-000000000004', 'b8000000-0000-4000-8000-000000000001', 'Dr. Former', 'doctor', false),
  ('b6000000-0000-4000-8000-000000000006', 'b8000000-0000-4000-8000-000000000001', 'Psychologist Solo', 'psychologist', true);
insert into clinical_private.care_teams(organization_id, nurse_id, doctor_id) values
  ('b8000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000002', 'b6000000-0000-4000-8000-000000000001');
insert into clinical_private.patients(id, display_name, identity_label, identity_verified)
select ('b9000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'Colleague patient ' || n, 'COLLEAGUE-' || n, true from generate_series(1, 3) n;
insert into clinical_private.organization_patients(organization_id, patient_id, active)
select 'b8000000-0000-4000-8000-000000000001', id, identity_label <> 'COLLEAGUE-3' from clinical_private.patients where identity_label like 'COLLEAGUE-%';
insert into clinical_private.assignments(patient_id, organization_id, clinician_id)
select id, 'b8000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001' from clinical_private.patients where identity_label like 'COLLEAGUE-%';

set local role authenticated;
select pg_temp.co_claims(1);
select pg_temp.co_assert(jsonb_array_length(pg_temp.co_list()) = 3, 'active colleagues of the own clinic only');
select pg_temp.co_assert(pg_temp.co_person(3) is null and pg_temp.co_person(4) is null, 'no other clinic, no inactive staff');
select pg_temp.co_assert((pg_temp.co_person(1)->>'patients')::int = 2, 'doctor workload counts active clinic patients');
select pg_temp.co_assert((pg_temp.co_person(1)->>'teamSize')::int = 1 and (pg_temp.co_person(1)->>'self')::boolean, 'team size and self');
select pg_temp.co_assert(pg_temp.co_person(2)->>'team' = 'Dr. Lead' and pg_temp.co_person(2)->'patients' = 'null'::jsonb, 'nurse shows team, not workload');
select pg_temp.co_assert(pg_temp.co_person(6)->'team' = 'null'::jsonb, 'member without a team');
select pg_temp.co_assert(pg_temp.co_person(2)->>'email' = 'colleague-2@example.invalid', 'e-mail for contact');

select pg_temp.co_claims(2);
select pg_temp.co_assert(public.clinician_set_phone(' +46 70-123 45 67 ')->>'phone' = '+46 70-123 45 67', 'own phone is set and trimmed');
select pg_temp.co_denied($$select public.clinician_set_phone('call me maybe')$$, '22023', 'phone must look like a number');
select pg_temp.co_claims(1);
select pg_temp.co_assert(pg_temp.co_person(2)->>'phone' = '+46 70-123 45 67', 'colleagues see the phone');
select pg_temp.co_assert(pg_temp.co_person(1)->'phone' = 'null'::jsonb, 'no phone until set');
select pg_temp.co_claims(2);
select pg_temp.co_assert(public.clinician_set_phone('')->'phone' = 'null'::jsonb, 'empty removes the phone');

select pg_temp.co_claims(5);
select pg_temp.co_denied($$select public.clinician_colleagues()$$, '42501', 'patient accounts cannot list staff');
select pg_temp.co_denied($$select public.clinician_set_phone('+46701234567')$$, '42501', 'patient accounts cannot set a staff phone');
select pg_temp.co_claims(4);
select pg_temp.co_denied($$select public.clinician_colleagues()$$, '42501', 'inactive staff cannot list colleagues');
select pg_temp.co_denied($$select phone from clinical_private.staff$$, '42501', 'staff table stays private');
reset role;
select pg_temp.co_assert((select count(*) = 2 from clinical_private.administration_audit
  where action = 'staff.phone' and actor_id = 'b6000000-0000-4000-8000-000000000002'), 'phone changes are audited');
select 'Colleagues tests passed: own clinic only, workload for doctors, team for others, own phone with audit.' as result;
