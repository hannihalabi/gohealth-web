-- Run inside a transaction and roll back all synthetic fixtures.
insert into auth.users(id,email,email_confirmed_at)
select ('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'pipeline-'||n||'@example.invalid',now() from generate_series(1,4)n;
insert into auth.sessions(id,user_id)
select ('a2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,4)n;
insert into clinical_private.organizations(id,name) values('a3000000-0000-4000-8000-000000000001','Pipeline A'),('a3000000-0000-4000-8000-000000000002','Pipeline B');
insert into clinical_private.administrators(user_id,organization_id,display_name) values
 ('a1000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000001','Admin A'),
 ('a1000000-0000-4000-8000-000000000004','a3000000-0000-4000-8000-000000000002','Admin B');
create function pg_temp.pl_claims(n int,aal text default 'aal2') returns void language plpgsql as $$begin
 perform set_config('request.jwt.claims',jsonb_build_object('sub','a1000000-0000-4000-8000-'||lpad(n::text,12,'0'),'aal',aal,'session_id','a2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::text,true);
end$$;
create function pg_temp.pl_assert(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'FAILED: %',label;end if;end$$;
create function pg_temp.pl_denied(q text,label text,expected text default '42501') returns void language plpgsql as $$begin
 begin execute q;exception when others then if sqlstate=expected then return;else raise exception 'WRONG ERROR % in %: %',sqlstate,label,sqlerrm;end if;end;
 raise exception 'UNEXPECTED SUCCESS: %',label;end$$;
-- Anonymous website application: stored once per open email.
set local role anon;
select public.submit_application('Anna Sökande','Anna@Example.invalid','Hej');
select public.submit_application('Anna Igen','anna@example.invalid',null);
select pg_temp.pl_denied($q$select public.submit_application('','bad',null)$q$,'invalid application','22023');
select pg_temp.pl_denied($q$select clinical_private.patient_pipeline('a3000000-0000-4000-8000-000000000001')$q$,'anon cannot read pipeline');
reset role;
select pg_temp.pl_assert((select count(*)=1 and min(email)='anna@example.invalid' from clinical_private.applications),'duplicate open application ignored, email normalised');
-- Patient finishes onboarding in the app.
select pg_temp.pl_claims(2);
set local role authenticated;
select pg_temp.pl_assert(public.gohealth_onboarding_status()->>'status'='none','status none before onboarding');
select pg_temp.pl_assert(public.gohealth_complete_onboarding('Pelle Patient','19900101-1234')->>'status'='pending','onboarding creates pending signup');
select pg_temp.pl_assert(public.gohealth_onboarding_status()->>'status'='pending','status pending after onboarding');
select public.gohealth_complete_onboarding('Pelle Patient','19900101-1234');
select pg_temp.pl_denied($q$select public.gohealth_complete_onboarding('','1')$q$,'invalid onboarding','22023');
select pg_temp.pl_denied($q$select clinical_private.patient_pipeline('a3000000-0000-4000-8000-000000000001')$q$,'non-admin denied');
reset role;
select pg_temp.pl_assert((select count(*)=1 from clinical_private.patient_signups where status='pending'),'repeat onboarding does not duplicate');
-- Administrator reads the real pipeline.
select set_config('t.signup',(select id::text from clinical_private.patient_signups where status='pending'),true),set_config('t.app',(select id::text from clinical_private.applications),true);
select pg_temp.pl_claims(1);
set local role authenticated;
select pg_temp.pl_assert((select (r->>'signupTotal')::int=1 and (r->>'applicationTotal')::int=1 and (r->>'registered')::int=0 from(select public.clinician_patient_pipeline('a3000000-0000-4000-8000-000000000001') r)x),'pipeline counts are exact');
select pg_temp.pl_denied($q$select public.clinician_decide_pipeline('a3000000-0000-4000-8000-000000000001','signup',current_setting('t.signup')::uuid,'approve',1,false)$q$,'approval requires identity attestation','22023');
select pg_temp.pl_denied($q$select public.clinician_decide_pipeline('a3000000-0000-4000-8000-000000000001','signup',current_setting('t.signup')::uuid,'approve',9,true)$q$,'stale revision denied','40001');
select pg_temp.pl_denied($q$select public.clinician_patient_pipeline('a3000000-0000-4000-8000-000000000002')$q$,'other clinic denied');
select public.clinician_decide_pipeline('a3000000-0000-4000-8000-000000000001','signup',current_setting('t.signup')::uuid,'approve',1,true);
select public.clinician_decide_pipeline('a3000000-0000-4000-8000-000000000001','application',current_setting('t.app')::uuid,'handled',1,false);
select pg_temp.pl_denied($q$select public.clinician_decide_pipeline('a3000000-0000-4000-8000-000000000001','application',current_setting('t.app')::uuid,'handled',1,false)$q$,'repeat decision denied','40001');
select pg_temp.pl_assert((select (r->>'signupTotal')::int=0 and (r->>'applicationTotal')::int=0 and (r->>'registered')::int=1 from(select public.clinician_patient_pipeline('a3000000-0000-4000-8000-000000000001') r)x),'approved patient is registered, queues are empty');
reset role;
select pg_temp.pl_assert((select identity_verified and identity_label='199001011234' from clinical_private.patients where account_id='a1000000-0000-4000-8000-000000000002'),'approved patient is verified with normalised identity');
select pg_temp.pl_claims(2);
set local role authenticated;
select pg_temp.pl_assert(public.gohealth_onboarding_status()->>'status'='approved','status approved after decision');
reset role;
select pg_temp.pl_assert((select count(*)=2 from clinical_private.administration_audit where action in('administration.signupapprove','administration.applicationhandled')),'decisions are audited');
-- Rejection.
select pg_temp.pl_claims(3);
set local role authenticated;
select public.gohealth_complete_onboarding('Rolf Rejected','19800101-0000');
reset role;
select set_config('t.signup',(select id::text from clinical_private.patient_signups where status='pending'),true);
select pg_temp.pl_claims(1);
set local role authenticated;
select public.clinician_decide_pipeline('a3000000-0000-4000-8000-000000000001','signup',current_setting('t.signup')::uuid,'reject',1,false);
reset role;
select pg_temp.pl_assert((select not exists(select 1 from clinical_private.patients where account_id='a1000000-0000-4000-8000-000000000003')),'rejected signup creates no patient');
select 'Patient pipeline tests passed: anonymous applications, onboarding signups, exact counts, approval with identity attestation, rejection, clinic isolation, stale revisions and audit.' as result;
