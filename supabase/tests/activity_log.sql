-- Synthetic transaction-only tests. The runner MUST rollback.
-- Users: 1 administrator, 2 doctor, 3 nurse, 4 patient account, 5 administrator of another clinic.
insert into auth.users(id,email,email_confirmed_at) select ('a1100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'activity-'||n||'@example.invalid',now() from generate_series(1,5)n;
insert into auth.sessions(id,user_id,user_agent,ip) select ('a1200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('a1100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Mozilla/5.0 Test',('192.0.2.'||n)::inet from generate_series(1,5)n;
insert into clinical_private.organizations(id,name) values ('a1300000-0000-4000-8000-000000000001','Activity clinic'),('a1300000-0000-4000-8000-000000000002','Other clinic');
insert into clinical_private.administrators(user_id,organization_id,display_name) values
 ('a1100000-0000-4000-8000-000000000001','a1300000-0000-4000-8000-000000000001','Activity admin'),
 ('a1100000-0000-4000-8000-000000000005','a1300000-0000-4000-8000-000000000002','Other admin');
insert into clinical_private.staff(user_id,organization_id,display_name,role) values
 ('a1100000-0000-4000-8000-000000000002','a1300000-0000-4000-8000-000000000001','Activity doctor','doctor'),
 ('a1100000-0000-4000-8000-000000000003','a1300000-0000-4000-8000-000000000001','Activity nurse','nurse');
insert into clinical_private.patients(id,account_id,display_name,identity_label,identity_verified) values
 ('a1400000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000004','Activity patient','ACT-1',true);
-- What happened: the doctor opened the journal 105 times and the overview once; the patient synced (not staff).
insert into clinical_private.audit(actor_id,patient_id,action,created_at)
select 'a1100000-0000-4000-8000-000000000002','a1400000-0000-4000-8000-000000000001','patient.open', now() - g * interval '1 minute' from generate_series(1,105) g;
insert into clinical_private.audit(actor_id,action) values ('a1100000-0000-4000-8000-000000000002','clinician.overview');
insert into clinical_private.audit(actor_id,patient_id,action) values ('a1100000-0000-4000-8000-000000000004','a1400000-0000-4000-8000-000000000001','patient.sync_all_app_values');
insert into clinical_private.administration_audit(organization_id,actor_id,action,subject_id,details) values
 ('a1300000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001','administration.member','a1100000-0000-4000-8000-000000000003','{"role":"nurse"}');
create function pg_temp.act_claims(n int) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claims',jsonb_build_object('sub','a1100000-0000-4000-8000-'||lpad(n::text,12,'0'),'aal','aal2','session_id','a1200000-0000-4000-8000-'||lpad(n::text,12,'0'))::text,true);
end$$;
create function pg_temp.act_assert(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'FAILED: %',label;end if;end$$;
create function pg_temp.act_fail(q text,label text,expected text default '42501') returns void language plpgsql as $$begin
 begin execute q;exception when others then if sqlstate=expected then return;else raise exception 'WRONG ERROR % in %: %',sqlstate,label,sqlerrm;end if;end;
 raise exception 'UNEXPECTED SUCCESS: %',label;end$$;
set local role authenticated;
select pg_temp.act_claims(1);
select pg_temp.act_assert((select count(*) = 3 and bool_and(a->>'user_id' <> 'a1100000-0000-4000-8000-000000000004')
  from jsonb_array_elements(public.clinician_activity_log('a1300000-0000-4000-8000-000000000001','accounts')->'accounts') a), 'accounts are the clinic staff and administrators, never patients');
select pg_temp.act_assert((select (a->>'events')::int = 106 and (a->>'sessions')::int = 1 from jsonb_array_elements(public.clinician_activity_log('a1300000-0000-4000-8000-000000000001','accounts')->'accounts') a
  where a->>'user_id' = 'a1100000-0000-4000-8000-000000000002'), 'the doctor has every event and one session counted');
-- Per account, newest first, paged without gaps or repeats; routine events are hidden unless asked for.
create temp table act_pages as select public.clinician_activity_log('a1300000-0000-4000-8000-000000000001','events',
  '{"account":"a1100000-0000-4000-8000-000000000002","category":"journal"}') as p;
grant select on act_pages to authenticated;
select pg_temp.act_assert((select jsonb_array_length(p->'events') = 100 and p->'next' is not null
  and bool_and(e->>'action' = 'patient.open' and e->>'patient' = 'Activity patient' and e->>'actor' = 'Activity doctor')
  from act_pages, jsonb_array_elements(p->'events') e group by p), 'first page: 100 journal events with patient and account');
select pg_temp.act_assert((select jsonb_array_length(public.clinician_activity_log('a1300000-0000-4000-8000-000000000001','events',
  jsonb_build_object('account','a1100000-0000-4000-8000-000000000002','category','journal','before',p->'next'->>'before','before_id',p->'next'->>'before_id'))->'events') = 5 from act_pages),
  'second page holds the remaining 5');
select pg_temp.act_assert((select jsonb_array_length(public.clinician_activity_log('a1300000-0000-4000-8000-000000000001','events',
  '{"account":"a1100000-0000-4000-8000-000000000002","category":"journal","routine":true,"days":1}')->'events') = 100), 'routine events are included on request');
select pg_temp.act_assert((select count(*) = 1 and bool_and(e->>'action' = 'administration.member' and e->'details'->>'subject' = 'Activity nurse')
  from jsonb_array_elements(public.clinician_activity_log('a1300000-0000-4000-8000-000000000001','events','{"category":"admin"}')->'events') e),
  'administration events name the affected person');
select pg_temp.act_assert((select count(*) = 3 and bool_and(e->'details'->>'ip' like '192.0.2.%')
  from jsonb_array_elements(public.clinician_activity_log('a1300000-0000-4000-8000-000000000001','events','{"category":"login"}')->'events') e),
  'sign-in sessions of staff and administrators, with device address');
select pg_temp.act_fail($q$select public.clinician_activity_log('a1300000-0000-4000-8000-000000000001','events','{"account":"a1100000-0000-4000-8000-000000000004"}')$q$, 'a patient is not an account here');
select pg_temp.act_fail($q$select public.clinician_activity_log('a1300000-0000-4000-8000-000000000001','events','{"days":999}')$q$, 'the period is bounded', '22023');
-- Only the clinic's own administrator, never staff or another clinic.
select pg_temp.act_claims(2);
select pg_temp.act_fail($q$select public.clinician_activity_log('a1300000-0000-4000-8000-000000000001','accounts')$q$, 'staff cannot review the log');
select pg_temp.act_claims(5);
select pg_temp.act_fail($q$select public.clinician_activity_log('a1300000-0000-4000-8000-000000000001','accounts')$q$, 'another clinic cannot review the log');
reset role;
select pg_temp.act_assert((select count(*) = 5 from clinical_private.administration_audit where action = 'administration.activity_review'
  and actor_id = 'a1100000-0000-4000-8000-000000000001'), 'every event review is itself logged (the account list shows counts only)');
select 'Activity log tests passed: clinic accounts, per-account events, keyset paging, routine filter, administration subjects, sessions, access, review logging.' as result;
