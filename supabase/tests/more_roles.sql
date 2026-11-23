-- Synthetic transaction-only tests. The runner MUST rollback.
-- Users: 1 administrator, 2 doctor, 3 psychologist (assigned), 4 secretary (not assigned), 5 patient account, 6 invitee.
insert into auth.users(id,email,email_confirmed_at)
select ('f1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'roles-'||n||'@example.invalid',now() from generate_series(1,6)n;
insert into auth.sessions(id,user_id) select ('f2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('f1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,6)n;
insert into clinical_private.organizations(id,name) values ('f3000000-0000-4000-8000-000000000001','Roles clinic');
insert into clinical_private.administrators(user_id,organization_id,display_name) values ('f1000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001','Roles admin');
insert into clinical_private.staff(user_id,organization_id,display_name,role) values
 ('f1000000-0000-4000-8000-000000000002','f3000000-0000-4000-8000-000000000001','Doctor','doctor'),
 ('f1000000-0000-4000-8000-000000000003','f3000000-0000-4000-8000-000000000001','Psychologist','psychologist'),
 ('f1000000-0000-4000-8000-000000000004','f3000000-0000-4000-8000-000000000001','Secretary','secretary');
insert into clinical_private.patients(id,account_id,display_name,identity_label,identity_verified) values
 ('f4000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000005','Roles patient','ROLES-1',true);
insert into clinical_private.organization_patients(organization_id,patient_id) values ('f3000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001');
insert into clinical_private.assignments(patient_id,organization_id,clinician_id) values
 ('f4000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000003');
create function pg_temp.r_claims(n int) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claims',jsonb_build_object('sub','f1000000-0000-4000-8000-'||lpad(n::text,12,'0'),'aal','aal2','session_id','f2000000-0000-4000-8000-'||lpad(n::text,12,'0'),'email','roles-'||n||'@example.invalid')::text,true);
end$$;
create function pg_temp.r_assert(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'FAILED: %',label;end if;end$$;
create function pg_temp.r_fail(q text,label text,expected text default '42501') returns void language plpgsql as $$begin
 begin execute q;exception when others then if sqlstate=expected then return;else raise exception 'WRONG ERROR % in %: %',sqlstate,label,sqlerrm;end if;end;
 raise exception 'UNEXPECTED SUCCESS: %',label;end$$;

-- Access works like a nurse's: assigned patients only; doctors see the whole clinic.
select pg_temp.r_assert(clinical_private.care_organization('f1000000-0000-4000-8000-000000000003','f4000000-0000-4000-8000-000000000001') = 'f3000000-0000-4000-8000-000000000001', 'an assigned psychologist has access');
select pg_temp.r_assert(clinical_private.care_organization('f1000000-0000-4000-8000-000000000004','f4000000-0000-4000-8000-000000000001') is null, 'an unassigned secretary has no access');
select pg_temp.r_assert(clinical_private.care_organization('f1000000-0000-4000-8000-000000000002','f4000000-0000-4000-8000-000000000001') is not null, 'a doctor still has clinic-wide access');
select pg_temp.r_fail($q$insert into clinical_private.staff(user_id,organization_id,display_name,role) values ('f1000000-0000-4000-8000-000000000006','f3000000-0000-4000-8000-000000000001','Janitor','janitor')$q$, 'unknown roles are rejected', '23514');

set local role authenticated;
-- The psychologist writes a draft but cannot publish it.
select pg_temp.r_claims(3);
create temp table roles_state as select public.clinician_save_record('f4000000-0000-4000-8000-000000000001', 'imaging',
  jsonb_build_object('title', 'Psykologbedömning', 'source', 'Synthetic', 'sampledAt', '2026-01-01T12:00:00Z', 'comment', '',
    'modality', 'OTHER', 'bodyPart', 'Synthetic', 'conclusion', 'Synthetic', 'studyId', ''), null, 0, null, '') as rec;
select pg_temp.r_fail(format('select public.clinician_publish_record(%L, 1)', rec->>'id'), 'a psychologist cannot publish') from roles_state;
select pg_temp.r_claims(4);
select pg_temp.r_fail($q$select public.clinician_patient('f4000000-0000-4000-8000-000000000001')$q$, 'an unassigned secretary cannot open the journal');

-- The administrator invites and edits staff with the new roles.
select pg_temp.r_claims(1);
select public.clinician_administration('invite','{"organizationId":"f3000000-0000-4000-8000-000000000001","name":"New secretary","email":"roles-6@example.invalid","role":"secretary","identityAttested":true}');
select pg_temp.r_fail($q$select public.clinician_administration('invite','{"organizationId":"f3000000-0000-4000-8000-000000000001","name":"Janitor","email":"janitor@example.invalid","role":"janitor","identityAttested":true}')$q$, 'unknown invitation role', '22023');
select public.clinician_administration('member', jsonb_build_object('organizationId','f3000000-0000-4000-8000-000000000001','userId','f1000000-0000-4000-8000-000000000004',
  'name','Secretary','role','psychologist','memberType','clinical','active',true,'identityAttested',true,'revision',1));
reset role;
select pg_temp.r_assert((select role = 'psychologist' from clinical_private.staff where user_id = 'f1000000-0000-4000-8000-000000000004'), 'a member can be changed to psychologist');
select pg_temp.r_assert((select role = 'secretary' from clinical_private.staff_invitations where email = 'roles-6@example.invalid'), 'a secretary can be invited');
-- Teams: every non-doctor role can work under a doctor; the link follows role changes.
set local role authenticated;
select pg_temp.r_claims(1);
select public.clinician_set_care_team('f3000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000003','f1000000-0000-4000-8000-000000000002',0);
select public.clinician_set_care_team('f3000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000004','f1000000-0000-4000-8000-000000000002',0);
select pg_temp.r_assert((select count(*) = 2 from jsonb_array_elements(public.clinician_system_overview('f3000000-0000-4000-8000-000000000001')->'members') m
  where m->>'doctor_id' = 'f1000000-0000-4000-8000-000000000002'), 'psychologists and secretaries are shown under their doctor');
select pg_temp.r_fail($q$select public.clinician_set_care_team('f3000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000002','f1000000-0000-4000-8000-000000000002',0)$q$, 'a doctor is not a team member');
reset role;
update clinical_private.staff set role = 'secretary', revision = revision + 1 where user_id = 'f1000000-0000-4000-8000-000000000004';
select pg_temp.r_assert((select doctor_id = 'f1000000-0000-4000-8000-000000000002' from clinical_private.care_teams where nurse_id = 'f1000000-0000-4000-8000-000000000004'), 'moving between team roles keeps the team');
update clinical_private.staff set role = 'doctor', revision = revision + 1 where user_id = 'f1000000-0000-4000-8000-000000000003';
select pg_temp.r_assert((select doctor_id is null from clinical_private.care_teams where nurse_id = 'f1000000-0000-4000-8000-000000000003'), 'becoming a doctor leaves the team');
select pg_temp.r_assert(clinical_private.care_organization('f1000000-0000-4000-8000-000000000004','f4000000-0000-4000-8000-000000000001') is null, 'team membership grants no patient access');
select 'Role tests passed: psychologist and medical secretary roles, assignment-based access, no publishing, invitations, edits and doctor teams.' as result;
