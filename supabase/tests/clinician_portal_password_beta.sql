-- Synthetic transaction-only tests. The runner MUST rollback.
insert into auth.users(id,email,email_confirmed_at)
select ('81000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
       'beta-test-'||n||'@example.invalid', now()
from generate_series(1,7) n;
insert into auth.sessions(id,user_id)
select ('82000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
       ('81000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
from generate_series(1,7) n;
insert into clinical_private.organizations(id,name) values
 ('83000000-0000-4000-8000-000000000001','Synthetic beta clinic A'),
 ('83000000-0000-4000-8000-000000000002','Synthetic beta clinic B');
insert into clinical_private.administrators(user_id,organization_id,display_name) values
 ('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001','Synthetic admin');
insert into clinical_private.staff(user_id,organization_id,display_name,role) values
 ('81000000-0000-4000-8000-000000000002','83000000-0000-4000-8000-000000000001','Synthetic doctor','doctor'),
 ('81000000-0000-4000-8000-000000000003','83000000-0000-4000-8000-000000000001','Synthetic nurse','nurse');
insert into clinical_private.patients(id,account_id,display_name,identity_label,identity_verified) values
 ('84000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000004','Synthetic patient A','BETA-TEST-A',true),
 ('84000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000005','Synthetic patient B','BETA-TEST-B',true);
insert into clinical_private.organization_patients(organization_id,patient_id) values
 ('83000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000001'),
 ('83000000-0000-4000-8000-000000000002','84000000-0000-4000-8000-000000000002');
insert into clinical_private.assignments(patient_id,organization_id,clinician_id) values
 ('84000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000002'),
 ('84000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000003');

create function pg_temp.beta_claims(n int, amr text default 'password', aal text default 'aal1') returns void
language sql as $$
 select set_config('request.jwt.claims',jsonb_build_object(
   'sub','81000000-0000-4000-8000-'||lpad(n::text,12,'0'),
   'session_id','82000000-0000-4000-8000-'||lpad(n::text,12,'0'),
   'aal',aal, 'amr',case when amr is null then null else jsonb_build_array(jsonb_build_object('method',amr)) end,
   'user_metadata',jsonb_build_object('role','admin','amr',jsonb_build_array(jsonb_build_object('method','password')))
 )::text,true)::void
$$;
create function pg_temp.beta_assert(ok boolean,label text) returns void language plpgsql as $$
begin
 if ok is distinct from true then raise exception 'FAILED: %',label; end if;
end $$;
create function pg_temp.beta_denied(query text,label text) returns void language plpgsql as $$
begin
 begin execute query; exception when insufficient_privilege then return; end;
 raise exception 'UNEXPECTED SUCCESS: %',label;
end $$;
create temp table beta_record(id uuid);
grant all on beta_record to authenticated;

update clinical_private.portal_settings set mfa_required=true where singleton;
set local role authenticated;
select pg_temp.beta_claims(1);
select pg_temp.beta_assert(public.clinician_session()->'mfa_required'='true','strict session reports MFA requirement');
select pg_temp.beta_denied($q$select public.clinician_administration('snapshot','{"organizationId":"83000000-0000-4000-8000-000000000001"}')$q$,'strict admin requires MFA');
select pg_temp.beta_claims(2);
select pg_temp.beta_denied('select public.clinician_list_patients()','strict clinician requires MFA');
reset role;

update clinical_private.portal_settings set mfa_required=false where singleton;
set local role authenticated;
select pg_temp.beta_claims(1);
select pg_temp.beta_assert(public.clinician_session()->'mfa_required'='false' and public.clinician_session()->'password_session'='true','beta session reports password authentication');
select pg_temp.beta_assert(jsonb_array_length(public.clinician_administration('snapshot','{"organizationId":"83000000-0000-4000-8000-000000000001"}')->'patients')=1,'password admin opens own organization');
select pg_temp.beta_assert(public.clinician_administration('invite',
 '{"organizationId":"83000000-0000-4000-8000-000000000001","email":"beta-test-6@example.invalid","name":"Synthetic invite","role":"doctor","identityAttested":true}')->'ok'='true',
 'password admin can create a role invitation');
select pg_temp.beta_denied($q$select public.clinician_administration('snapshot','{"organizationId":"83000000-0000-4000-8000-000000000002"}')$q$,'password admin cannot open another organization');
select pg_temp.beta_denied($q$select public.clinician_patient('84000000-0000-4000-8000-000000000001')$q$,'password admin cannot read clinical content');
select pg_temp.beta_denied('update clinical_private.portal_settings set mfa_required=true','app session cannot change settings');
select pg_temp.beta_claims(1,'recovery');
select pg_temp.beta_assert(public.clinician_session()->'password_session'='false','recovery session has no password proof');
select pg_temp.beta_denied($q$select public.clinician_administration('snapshot','{"organizationId":"83000000-0000-4000-8000-000000000001"}')$q$,'recovery session cannot administer');

select pg_temp.beta_claims(2);
select pg_temp.beta_assert(jsonb_array_length(public.clinician_list_patients())=1,'password clinician sees assigned patient');
select pg_temp.beta_denied($q$select public.clinician_patient('84000000-0000-4000-8000-000000000002')$q$,'password clinician cannot read another patient');
select pg_temp.beta_claims(2,'otp');
select pg_temp.beta_denied('select public.clinician_list_patients()','OTP does not grant clinical access');
select pg_temp.beta_claims(2,null);
select pg_temp.beta_denied('select public.clinician_list_patients()','user metadata cannot replace missing AMR');
select pg_temp.beta_claims(3);
insert into beta_record select (public.clinician_save_record('84000000-0000-4000-8000-000000000001','vaccination',
 jsonb_build_object('title','Synthetic vaccination','source','Synthetic','sampledAt',now()-interval '1 day','comment','',
 'vaccine','Synthetic','dose','1','location','Synthetic clinic','batch','SYNTH-1'),null,0,null,'')->>'id')::uuid;
select pg_temp.beta_denied(format('select public.clinician_publish_record(%L,1)',id),'password nurse cannot publish') from beta_record;
select pg_temp.beta_claims(2);
select public.clinician_publish_record(id,1) from beta_record;

select pg_temp.beta_claims(4,'otp');
select pg_temp.beta_assert(jsonb_array_length(public.gohealth_patient_data()->'records')=1,'patient still reads own published record');
select pg_temp.beta_claims(5,'otp');
select pg_temp.beta_assert(jsonb_array_length(public.gohealth_patient_data()->'records')=0,'other patient cannot read the record');
select pg_temp.beta_claims(6,'recovery');
select pg_temp.beta_assert(public.clinician_session()->'access'='false' and public.clinician_session()->'mfa_required'='false','invited account sees recovery policy without a staff role');
select pg_temp.beta_assert(jsonb_array_length(public.clinician_administration('pending','{}'))=1,'password admin invitation belongs to the invited email');
select pg_temp.beta_claims(7);
select pg_temp.beta_denied('select public.clinician_list_patients()','authenticated user without staff role sees no patients');
reset role;

delete from auth.sessions where user_id='81000000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.beta_claims(2);
select pg_temp.beta_denied('select public.clinician_list_patients()','revoked password session cannot list patients');
reset role;
delete from clinical_private.portal_settings where singleton;
select pg_temp.beta_assert(clinical_private.portal_mfa_required(),'missing configuration requires MFA');
select 'Password beta tests passed: strict default, password proof, both portals, invitation discovery, patient and organization isolation, publishing roles, and revocation.' as result;
