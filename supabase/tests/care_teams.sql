-- Run inside a transaction and roll back all synthetic fixtures.
insert into auth.users(id,email,email_confirmed_at)
select ('94000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'care-team-'||n||'@example.invalid',now() from generate_series(1,6)n;
insert into auth.sessions(id,user_id)
select ('95000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('94000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,6)n;
insert into clinical_private.organizations(id,name) values('96000000-0000-4000-8000-000000000001','Team A'),('96000000-0000-4000-8000-000000000002','Team B');
insert into clinical_private.administrators(user_id,organization_id,display_name) values('94000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000001','Admin A');
insert into clinical_private.staff(user_id,organization_id,display_name,role) values
 ('94000000-0000-4000-8000-000000000002','96000000-0000-4000-8000-000000000001','Doctor A','doctor'),
 ('94000000-0000-4000-8000-000000000003','96000000-0000-4000-8000-000000000001','Nurse A','nurse'),
 ('94000000-0000-4000-8000-000000000004','96000000-0000-4000-8000-000000000002','Doctor B','doctor'),
 ('94000000-0000-4000-8000-000000000005','96000000-0000-4000-8000-000000000002','Nurse B','nurse'),
 ('94000000-0000-4000-8000-000000000006','96000000-0000-4000-8000-000000000001','Doctor A2','doctor'),
 ('94000000-0000-4000-8000-000000000002','96000000-0000-4000-8000-000000000002','Doctor A in B','doctor');
insert into clinical_private.patients(id,display_name,identity_label,identity_verified)
select ('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Synthetic workload patient '||n,'TEAM-TEST-'||n,true from generate_series(1,105)n;
insert into clinical_private.organization_patients(organization_id,patient_id,active)
select '96000000-0000-4000-8000-000000000001',id,id<>'97000000-0000-4000-8000-000000000104' from clinical_private.patients where identity_label like 'TEAM-TEST-%' and id<>'97000000-0000-4000-8000-000000000105';
insert into clinical_private.organization_patients(organization_id,patient_id) values('96000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000105');
insert into clinical_private.assignments(patient_id,organization_id,clinician_id,active)
select patient_id,organization_id,'94000000-0000-4000-8000-000000000002',patient_id<>'97000000-0000-4000-8000-000000000003' from clinical_private.organization_patients where organization_id in ('96000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000002');
insert into clinical_private.assignments(patient_id,organization_id,clinician_id) values('97000000-0000-4000-8000-000000000001','96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003');
create function pg_temp.team_claims(n int,aal text default 'aal2') returns void language plpgsql as $$begin
 perform set_config('request.jwt.claims',jsonb_build_object('sub','94000000-0000-4000-8000-'||lpad(n::text,12,'0'),'aal',aal,'session_id','95000000-0000-4000-8000-'||lpad(n::text,12,'0'))::text,true);
end$$;
create function pg_temp.team_assert(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'FAILED: %',label;end if;end$$;
create function pg_temp.team_denied(q text,label text,expected text default '42501') returns void language plpgsql as $$begin
 begin execute q;exception when others then if sqlstate=expected then return;else raise exception 'WRONG ERROR % in %: %',sqlstate,label,sqlerrm;end if;end;
 raise exception 'UNEXPECTED SUCCESS: %',label;end$$;
create function pg_temp.workload() returns jsonb language sql as $$
 select public.clinician_system_overview('96000000-0000-4000-8000-000000000001')->'members'
$$;
select pg_temp.team_claims(1);
set local role authenticated;
select pg_temp.team_assert((select (m->>'patient_count')::int=102 from jsonb_array_elements(pg_temp.workload())m where m->>'user_id'='94000000-0000-4000-8000-000000000002'),'exact workload beyond patient-list limit, active and clinic scoped');
select pg_temp.team_assert((select (m->>'patient_count')::int=1 from jsonb_array_elements(pg_temp.workload())m where m->>'user_id'='94000000-0000-4000-8000-000000000003'),'nurse has own patient count');
select pg_temp.team_denied($q$select * from clinical_private.care_teams$q$,'private teams table');
select pg_temp.team_denied($q$select public.clinician_set_care_team('96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003','94000000-0000-4000-8000-000000000004',0)$q$,'cross-clinic doctor');
select pg_temp.team_denied($q$select public.clinician_set_care_team('96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000005','94000000-0000-4000-8000-000000000002',0)$q$,'cross-clinic nurse');
select pg_temp.team_denied($q$select public.clinician_set_care_team('96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003','94000000-0000-4000-8000-000000000003',0)$q$,'nurse cannot be own doctor');
select public.clinician_set_care_team('96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003','94000000-0000-4000-8000-000000000002',0);
select pg_temp.team_assert((select m->>'doctor_id'='94000000-0000-4000-8000-000000000002' and m->>'team_revision'='1' and m->>'patient_count'='1' from jsonb_array_elements(pg_temp.workload())m where m->>'user_id'='94000000-0000-4000-8000-000000000003'),'team affiliation is exposed without inheriting workload');
select pg_temp.team_denied($q$select public.clinician_set_care_team('96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003',null,0)$q$,'stale team edit','40001');
select pg_temp.team_claims(3);
select pg_temp.team_denied($q$select public.clinician_patient('97000000-0000-4000-8000-000000000002')$q$,'team membership never grants patient access');
select pg_temp.team_denied($q$select public.clinician_set_care_team('96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003',null,1)$q$,'nurse cannot assign teams');
select pg_temp.team_claims(1,'aal1');
select pg_temp.team_denied($q$select public.clinician_set_care_team('96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003',null,1)$q$,'assurance required');
select pg_temp.team_claims(1);
select public.clinician_set_care_team('96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003','94000000-0000-4000-8000-000000000006',1);
select public.clinician_set_care_team('96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003',null,2);
select public.clinician_set_care_team('96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003','94000000-0000-4000-8000-000000000002',3);
reset role;
update clinical_private.staff set active=false where organization_id='96000000-0000-4000-8000-000000000001' and user_id='94000000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.team_assert((select m->>'patient_count'='0' from jsonb_array_elements(pg_temp.workload())m where m->>'user_id'='94000000-0000-4000-8000-000000000002'),'inactive clinician workload is zero');
select pg_temp.team_assert((select m->'doctor_id'='null'::jsonb and m->>'team_revision'='5' from jsonb_array_elements(pg_temp.workload())m where m->>'user_id'='94000000-0000-4000-8000-000000000003'),'doctor deactivation clears link and advances revision');
reset role;
update clinical_private.staff set active=true where organization_id='96000000-0000-4000-8000-000000000001' and user_id='94000000-0000-4000-8000-000000000002';
update clinical_private.staff set active=false where organization_id='96000000-0000-4000-8000-000000000001' and user_id='94000000-0000-4000-8000-000000000003';
set local role authenticated;
select pg_temp.team_denied($q$select public.clinician_set_care_team('96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003','94000000-0000-4000-8000-000000000002',5)$q$,'inactive nurse denied');
reset role;
update clinical_private.staff set active=true where organization_id='96000000-0000-4000-8000-000000000001' and user_id='94000000-0000-4000-8000-000000000003';
set local role authenticated;
select public.clinician_set_care_team('96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003','94000000-0000-4000-8000-000000000002',5);
reset role;
update clinical_private.staff set role='nurse' where organization_id='96000000-0000-4000-8000-000000000001' and user_id='94000000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.team_assert((select m->'doctor_id'='null'::jsonb and m->>'team_revision'='7' from jsonb_array_elements(pg_temp.workload())m where m->>'user_id'='94000000-0000-4000-8000-000000000003'),'doctor role change clears affiliation');
select public.clinician_set_care_team('96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003','94000000-0000-4000-8000-000000000006',7);
reset role;
update clinical_private.staff set role='doctor' where organization_id='96000000-0000-4000-8000-000000000001' and user_id='94000000-0000-4000-8000-000000000003';
select pg_temp.team_assert((select doctor_id is null and revision=9 from clinical_private.care_teams where organization_id='96000000-0000-4000-8000-000000000001' and nurse_id='94000000-0000-4000-8000-000000000003'),'nurse role change clears affiliation');
update clinical_private.administrators set active=false where user_id='94000000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.team_denied($q$select public.clinician_set_care_team('96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003',null,9)$q$,'revoked administrator denied');
reset role;
set local role anon;
select pg_temp.team_denied($q$select public.clinician_set_care_team('96000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000003',null,9)$q$,'anonymous denied');
reset role;
select 'Care team tests passed: exact active workload, clinic isolation, role validation, optimistic revisions, affiliation clearing, no inherited patient access, assurance and revocation.' as result;
