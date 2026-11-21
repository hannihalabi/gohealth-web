-- Synthetic transaction-only tests. The runner MUST rollback.
insert into auth.users(id,email,email_confirmed_at)
select ('71000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'admin-test-'||n||'@example.invalid',case when n=7 then null else now() end from generate_series(1,12)n;
insert into auth.sessions(id,user_id) select ('72000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('71000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,12)n;
insert into clinical_private.organizations(id,name) values
 ('73000000-0000-4000-8000-000000000001','Test organisation A'),('73000000-0000-4000-8000-000000000002','Test organisation B'),('73000000-0000-4000-8000-000000000003','Bootstrap test');
insert into clinical_private.administrators(user_id,organization_id,display_name) values
 ('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','Admin A'),
 ('71000000-0000-4000-8000-000000000002','73000000-0000-4000-8000-000000000002','Admin B'),
 ('71000000-0000-4000-8000-000000000008','73000000-0000-4000-8000-000000000001','Second admin A');
insert into clinical_private.staff(user_id,organization_id,display_name,role) values
 ('71000000-0000-4000-8000-000000000003','73000000-0000-4000-8000-000000000001','Doctor A','doctor'),
 ('71000000-0000-4000-8000-000000000006','73000000-0000-4000-8000-000000000002','Doctor B','doctor');
insert into clinical_private.patients(id,account_id,display_name,identity_label,identity_verified) values
 ('74000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000005','Synthetic patient','ADMIN-TEST-1',true);
insert into clinical_private.organization_patients(organization_id,patient_id) values('73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000001');
insert into clinical_private.assignments(patient_id,organization_id,clinician_id) values('74000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000003');
create function pg_temp.claims(n int,aal text default 'aal2') returns void language plpgsql as $$begin
 perform set_config('request.jwt.claims',jsonb_build_object('sub','71000000-0000-4000-8000-'||lpad(n::text,12,'0'),'aal',aal,'session_id','72000000-0000-4000-8000-'||lpad(n::text,12,'0'),'email','admin-test-1@example.invalid','user_metadata',jsonb_build_object('role','admin'))::text,true);
end$$;
create function pg_temp.assert_true(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'FAILED: %',label;end if;end$$;
create function pg_temp.must_fail(q text,label text,expected text default '42501') returns void language plpgsql as $$begin
 begin execute q;exception when others then if sqlstate=expected then return;else raise exception 'WRONG ERROR % in %: %',sqlstate,label,sqlerrm;end if;end;
 raise exception 'UNEXPECTED SUCCESS: %',label;end$$;
create temp table admin_test_state(invitation uuid);
grant all on admin_test_state to authenticated;
select pg_temp.claims(1);
set local role authenticated;
select pg_temp.assert_true((public.clinician_session()->>'admin')::boolean and not (public.clinician_session()->>'clinical')::boolean,'admin session has no clinical role');
select pg_temp.assert_true(jsonb_array_length(public.clinician_administration('snapshot','{"organizationId":"73000000-0000-4000-8000-000000000001","query":""}')->'patients')=1,'own organisation metadata');
select pg_temp.assert_true(not public.clinician_administration('snapshot','{"organizationId":"73000000-0000-4000-8000-000000000001","query":""}') ? 'records','no clinical payload in admin snapshot');
select pg_temp.must_fail($q$select public.clinician_patient('74000000-0000-4000-8000-000000000001')$q$,'admin cannot read clinical profile');
select pg_temp.must_fail($q$select public.clinician_administration('snapshot','{"organizationId":"73000000-0000-4000-8000-000000000002","query":""}')$q$,'cross organisation denied');
select pg_temp.must_fail('select * from clinical_private.administrators','no direct admin tables');
select pg_temp.must_fail($q$select public.clinician_administration('invite','{"organizationId":"73000000-0000-4000-8000-000000000001","name":"Self","email":"admin-test-1@example.invalid","role":"doctor","identityAttested":true}')$q$,'cannot grant self clinical access','22023');
select pg_temp.claims(1,'aal1');
select pg_temp.must_fail($q$select public.clinician_administration('snapshot','{"organizationId":"73000000-0000-4000-8000-000000000001"}')$q$,'administrator MFA required');
select pg_temp.claims(3);
select pg_temp.must_fail($q$select public.clinician_administration('snapshot','{"organizationId":"73000000-0000-4000-8000-000000000001"}')$q$,'doctor metadata cannot grant admin');
select pg_temp.claims(1);
select public.clinician_administration('invite','{"organizationId":"73000000-0000-4000-8000-000000000001","name":"New doctor","email":"admin-test-4@example.invalid","role":"doctor","identityAttested":true}');
select pg_temp.claims(4,'aal1');
insert into admin_test_state select (public.clinician_administration('pending','{}')->0->>'id')::uuid;
select pg_temp.claims(5,'aal1');
select pg_temp.must_fail(format('select public.clinician_administration(%L,%L::jsonb)','accept',jsonb_build_object('id',invitation)),'wrong verified email cannot accept') from admin_test_state;
select pg_temp.claims(7,'aal1');
select pg_temp.must_fail('select public.clinician_administration(''pending'',''{}'')','unverified email cannot activate');
select pg_temp.claims(4,'aal1');
select public.clinician_administration('accept',jsonb_build_object('id',invitation)) from admin_test_state;
select pg_temp.must_fail(format('select public.clinician_administration(%L,%L::jsonb)','accept',jsonb_build_object('id',invitation)),'invitation cannot be replayed') from admin_test_state;
select pg_temp.must_fail('select public.clinician_list_patients('''')','new staff still needs MFA');
select pg_temp.claims(4);
select pg_temp.assert_true(jsonb_array_length(public.clinician_list_patients(''))=0,'new doctor has no automatic patient access');
select pg_temp.claims(1);
select pg_temp.must_fail($q$select public.clinician_administration('assignment','{"organizationId":"73000000-0000-4000-8000-000000000001","patientId":"74000000-0000-4000-8000-000000000001","userId":"71000000-0000-4000-8000-000000000006","active":true,"revision":0}')$q$,'cannot assign staff from another organisation');
select public.clinician_administration('assignment','{"organizationId":"73000000-0000-4000-8000-000000000001","patientId":"74000000-0000-4000-8000-000000000001","userId":"71000000-0000-4000-8000-000000000004","active":true,"revision":0}');
select pg_temp.claims(4);
select pg_temp.assert_true(jsonb_array_length(public.clinician_list_patients(''))=1,'explicit care assignment works');
select pg_temp.claims(1);
select public.clinician_administration('invite','{"organizationId":"73000000-0000-4000-8000-000000000001","name":"Old grant","email":"admin-test-4@example.invalid","role":"nurse","identityAttested":true}');
select public.clinician_administration('member','{"organizationId":"73000000-0000-4000-8000-000000000001","userId":"71000000-0000-4000-8000-000000000004","name":"New doctor","role":"doctor","memberType":"clinical","active":false,"revision":1,"identityAttested":true}');
select pg_temp.must_fail($q$select public.clinician_administration('member','{"organizationId":"73000000-0000-4000-8000-000000000001","userId":"71000000-0000-4000-8000-000000000004","name":"New doctor","role":"doctor","memberType":"clinical","active":true,"revision":1,"identityAttested":true}')$q$,'stale staff update','40001');
select public.clinician_administration('member','{"organizationId":"73000000-0000-4000-8000-000000000001","userId":"71000000-0000-4000-8000-000000000004","name":"New doctor","role":"doctor","memberType":"clinical","active":true,"revision":2,"identityAttested":true}');
select pg_temp.claims(4);
select pg_temp.assert_true(jsonb_array_length(public.clinician_list_patients(''))=0,'reactivation never restores old assignments');
select pg_temp.assert_true(jsonb_array_length(public.clinician_administration('pending','{}'))=0,'older grant cancelled by deactivation');
select pg_temp.claims(1);
select pg_temp.must_fail($q$select public.clinician_administration('member','{"organizationId":"73000000-0000-4000-8000-000000000001","userId":"71000000-0000-4000-8000-000000000001","name":"Self","role":"admin","memberType":"admin","active":false,"revision":1}')$q$,'self deactivation denied','22023');
select pg_temp.must_fail($q$select public.clinician_administration('patient','{"organizationId":"73000000-0000-4000-8000-000000000001","name":"Patient","email":"admin-test-11@example.invalid","identity":"ADMIN-TEST-2","identityAttested":false}')$q$,'patient identity attestation required','22023');
select public.clinician_administration('patient','{"organizationId":"73000000-0000-4000-8000-000000000001","name":"Patient","email":"admin-test-11@example.invalid","identity":"ADMIN-TEST-2","identityAttested":true}');
select pg_temp.claims(2);
select pg_temp.assert_true(jsonb_array_length(public.clinician_administration('snapshot','{"organizationId":"73000000-0000-4000-8000-000000000002"}')->'patients')=0,'new patient metadata hidden from other admin');
select pg_temp.claims(1);
select public.clinician_administration('invite','{"organizationId":"73000000-0000-4000-8000-000000000001","name":"Waiting","email":"admin-test-10@example.invalid","role":"admin","identityAttested":true}');
select pg_temp.claims(10,'aal1');
delete from admin_test_state;
insert into admin_test_state select (public.clinician_administration('pending','{}')->0->>'id')::uuid;
select pg_temp.claims(8);
select public.clinician_administration('member','{"organizationId":"73000000-0000-4000-8000-000000000001","userId":"71000000-0000-4000-8000-000000000001","name":"Admin A","role":"admin","memberType":"admin","active":false,"revision":1}');
select pg_temp.claims(1);
select pg_temp.must_fail($q$select public.clinician_administration('snapshot','{"organizationId":"73000000-0000-4000-8000-000000000001"}')$q$,'admin revocation immediate');
select pg_temp.claims(10,'aal1');
select pg_temp.must_fail(format('select public.clinician_administration(%L,%L::jsonb)','accept',jsonb_build_object('id',invitation)),'revoked inviter cancels outstanding access') from admin_test_state;
reset role;
insert into clinical_private.staff_invitations(organization_id,email,display_name,role,bootstrap,identity_attested)
values('73000000-0000-4000-8000-000000000003','admin-test-12@example.invalid','First admin','admin',true,true);
select pg_temp.claims(12,'aal1');
set local role authenticated;
delete from admin_test_state;
insert into admin_test_state select (public.clinician_administration('pending','{}')->0->>'id')::uuid;
select pg_temp.assert_true(public.clinician_administration('accept',jsonb_build_object('id',invitation))->>'admin'='true','bootstrap binds verified email') from admin_test_state;
select pg_temp.must_fail($q$select public.clinician_administration('snapshot','{"organizationId":"73000000-0000-4000-8000-000000000003"}')$q$,'first admin needs MFA after activation');
reset role;
delete from auth.sessions where user_id='71000000-0000-4000-8000-000000000012';
set local role authenticated;
select pg_temp.must_fail('select public.clinician_administration(''pending'',''{}'')','revoked session cannot activate or administer');
reset role;
select 'Administration tests passed: organisation isolation, clinical separation, MFA, verified-email activation, replay prevention, stale revisions, revocation, patient assignment and bootstrap.' as result;
