-- Run inside a transaction; the runner MUST rollback. No email or auth API calls.
insert into auth.users(id) select ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,5)n;
insert into auth.sessions(id,user_id) select ('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,5)n;
insert into clinical_private.organizations values('30000000-0000-4000-8000-000000000001','Regression test');
insert into clinical_private.staff(user_id,organization_id,display_name,role,active) values
 ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','Doctor A','doctor',true),
 ('10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001','Doctor B','doctor',true),
 ('10000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000001','Nurse','nurse',true);
insert into clinical_private.patients(id,account_id,display_name,identity_label,identity_verified) values
 ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','Test Patient A','CLINICAL-TEST-A',true),
 ('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000004','Test Patient B','CLINICAL-TEST-B',true);
insert into clinical_private.assignments(patient_id,organization_id,clinician_id,active) values
 ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',true),
 ('40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',true),
 ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000005',true);
create function pg_temp.claims(n int,aal text default 'aal2') returns void language plpgsql as $$begin
 perform set_config('request.jwt.claims',jsonb_build_object('sub','10000000-0000-4000-8000-'||lpad(n::text,12,'0'),'aal',aal,'session_id','20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::text,true);
end$$;
create function pg_temp.assert_true(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'FAILED: %',label;end if;end$$;
create function pg_temp.must_fail(q text,label text,expected text default '42501') returns void language plpgsql as $$begin
 begin execute q; exception when others then if sqlstate=expected then return;else raise exception 'WRONG ERROR % in %: %',sqlstate,label,sqlerrm;end if;end;
 raise exception 'UNEXPECTED SUCCESS: %',label;
end$$;
create temp table test_state(data jsonb);
grant all on table test_state to authenticated;
select pg_temp.claims(1);
set local role authenticated;
select pg_temp.assert_true((public.clinician_session()->>'staff')::boolean,'staff session');
select pg_temp.assert_true(jsonb_array_length(public.clinician_list_patients(''))=1,'only assigned patient');
select pg_temp.assert_true(jsonb_array_length(public.clinician_list_patients('CLINICAL-TEST-B'))=0,'search restricted');
select pg_temp.must_fail($q$select public.clinician_patient('40000000-0000-4000-8000-000000000002')$q$,'other patient');
select pg_temp.must_fail('select * from clinical_private.patients','no direct tables');
insert into test_state select public.clinician_save_record('40000000-0000-4000-8000-000000000001','lab',
 jsonb_build_object('title','Test','source','Synthetic','sampledAt',now()-interval '1 day','comment','', 'observations',jsonb_build_array(jsonb_build_object('code','tsh','name','TSH','value','3.2','comparator','=','unit','mIE/L','referenceLow',0.4,'referenceHigh',4,'referenceText',''))),null,0,null,'');
select pg_temp.assert_true((public.clinician_patient('40000000-0000-4000-8000-000000000001')->'records'->0->>'status')='draft','draft saved');
select pg_temp.must_fail(format('select public.clinician_save_record(%L,%L,%L::jsonb,%L,null,null,%L)','40000000-0000-4000-8000-000000000001','lab',data->'payload',data->>'id',''),'null revision rejected','40001') from test_state;
select pg_temp.must_fail(format('select public.clinician_save_record(%L,%L,%L::jsonb,%L,99,null,%L)','40000000-0000-4000-8000-000000000001','lab',data->'payload',data->>'id',''),'stale edit','40001') from test_state;
select pg_temp.claims(1,'aal1');
select pg_temp.must_fail('select public.clinician_list_patients('''')','MFA required');
select pg_temp.claims(3,'aal1');
select pg_temp.assert_true(jsonb_array_length(public.gohealth_patient_data()->'records')=0,'patient cannot see draft');
select pg_temp.must_fail('select public.clinician_list_patients('''')','patient cannot list patients');
select pg_temp.claims(5);
select pg_temp.must_fail(format('select public.clinician_publish_record(%L,1)',data->>'id'),'nurse cannot publish') from test_state;
select pg_temp.claims(1);
select public.clinician_publish_record((data->>'id')::uuid,1) from test_state;
select pg_temp.must_fail(format('select public.clinician_save_record(%L,%L,%L::jsonb,null,0,%L,null)','40000000-0000-4000-8000-000000000001','lab',data->'payload',data->>'id'),'correction needs reason','23514') from test_state;
select pg_temp.must_fail(format('select public.clinician_publish_record(%L,1)',data->>'id'),'double publish','40001') from test_state;
select pg_temp.claims(4,'aal1');
select pg_temp.assert_true(jsonb_array_length(public.gohealth_patient_data()->'records')=0,'other patient sees nothing');
select pg_temp.claims(3,'aal1');
select pg_temp.assert_true(jsonb_array_length(public.gohealth_patient_data()->'records')=1,'published visible to owner');
select public.gohealth_ingest_vitals(jsonb_build_array(jsonb_build_object('source_id','50000000-0000-4000-8000-000000000001','kind','resting-heart-rate','value',60,'unit','beats/min','start_at',now()-interval '1 hour','end_at',now()-interval '1 hour','source','Synthetic','definition','resting-heart-rate')),'[]');
select public.gohealth_ingest_vitals(jsonb_build_array(jsonb_build_object('source_id','50000000-0000-4000-8000-000000000001','kind','resting-heart-rate','value',60,'unit','beats/min','start_at',now()-interval '1 hour','end_at',now()-interval '1 hour','source','Synthetic','definition','resting-heart-rate')),'[]');
select pg_temp.claims(1);
select pg_temp.assert_true(jsonb_array_length(public.clinician_patient('40000000-0000-4000-8000-000000000001')->'vitals')=1,'idempotent vitals');
select pg_temp.claims(3,'aal1');
select public.gohealth_ingest_vitals('[]','["50000000-0000-4000-8000-000000000001"]');
select pg_temp.claims(1);
select pg_temp.assert_true(jsonb_array_length(public.clinician_patient('40000000-0000-4000-8000-000000000001')->'vitals')=0,'deletion propagated');
select pg_temp.claims(3,'aal1');
select public.gohealth_ingest_vitals(jsonb_build_array(jsonb_build_object(
 'source_id','50000000-0000-4000-8000-000000000002','kind','steps','value',4210,'unit','count',
 'start_at','2026-11-09T23:00:00Z','end_at','2026-11-10T12:00:00Z','calendar_day','2026-11-10',
 'source','Apple Hälsa','definition','steps-daily')),'[]');
select public.gohealth_ingest_vitals(jsonb_build_array(jsonb_build_object(
 'source_id','50000000-0000-4000-8000-000000000002','kind','steps','value',6320,'unit','count',
 'start_at','2026-11-09T23:00:00Z','end_at','2026-11-10T23:00:00Z','calendar_day','2026-11-10',
 'source','Apple Hälsa','definition','steps-daily')),'[]');
select public.gohealth_ingest_vitals(jsonb_build_array(jsonb_build_object(
 'source_id','50000000-0000-4000-8000-000000000002','kind','steps','value',4210,'unit','count',
 'start_at','2026-11-09T23:00:00Z','end_at','2026-11-10T12:00:00Z','calendar_day','2026-11-10',
 'source','Apple Hälsa','definition','steps-daily')),'[]');
reset role;
insert into clinical_private.vitals(patient_id,source_id,kind,value,unit,start_at,end_at,source,definition)
 select '40000000-0000-4000-8000-000000000001',gen_random_uuid(),'heart-rate',60,'beats/min',
   '2026-11-20T00:00:00Z'::timestamptz + n * interval '1 second',
   '2026-11-20T00:00:00Z'::timestamptz + n * interval '1 second','Synthetic','heart-rate'
 from generate_series(1,505)n;
select pg_temp.claims(1);
set local role authenticated;
with detail as (select public.clinician_patient('40000000-0000-4000-8000-000000000001')->'vitals' as v)
select pg_temp.assert_true(
 jsonb_array_length(v)=101
 and v->100->>'calendar_day'='2026-11-10' and v->100->>'value'='6320',
 'per-kind limit preserves older steps and daily totals update without duplicates') from detail;
with detail as (select public.clinician_patient('40000000-0000-4000-8000-000000000001')->'vitals'->99 as last)
select pg_temp.assert_true(jsonb_array_length(public.clinician_vital_history(
 '40000000-0000-4000-8000-000000000001','heart-rate',(last->>'end_at')::timestamptz,(last->>'id')::uuid))=100,
 'older vitals are paginated') from detail;
select pg_temp.must_fail($q$select public.clinician_vital_history(
 '40000000-0000-4000-8000-000000000002','steps',now(),'50000000-0000-4000-8000-000000000002')$q$,
 'vital history requires an active care relation');
insert into test_state select public.clinician_save_record('40000000-0000-4000-8000-000000000001','lab',data->'payload',null,0,(data->>'id')::uuid,'Corrected source') from test_state limit 1;
select public.clinician_publish_record((data->>'id')::uuid,1) from test_state where data->>'replaces_id' is not null;
select pg_temp.claims(3,'aal1');
select pg_temp.assert_true(jsonb_array_length(public.gohealth_patient_data()->'records')=1,'only latest correction visible');
select pg_temp.assert_true((public.gohealth_patient_data()->'records'->0->>'version')::int=2,'correction version');
reset role;
select pg_temp.must_fail($q$update clinical_private.records set payload=jsonb_set(payload,'{title}','"tampered"') where status='published'$q$,'published content immutable');
update clinical_private.assignments set active=false where clinician_id='10000000-0000-4000-8000-000000000001';
select pg_temp.claims(1);
set local role authenticated;
select pg_temp.must_fail($q$select public.clinician_patient('40000000-0000-4000-8000-000000000001')$q$,'revoked assignment immediate');
select pg_temp.must_fail($q$select public.clinician_vital_history(
 '40000000-0000-4000-8000-000000000001','steps',now(),'50000000-0000-4000-8000-000000000002')$q$,
 'vital history rejects a revoked assignment');
reset role;
delete from auth.sessions where user_id='10000000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.must_fail('select public.clinician_session()','revoked session immediate');
reset role;
select 'Clinical tests passed: assignment isolation, direct access, MFA, publication, correction, concurrent revisions, patient isolation, vital deduplication and deletion, revoked care relation and session.' as result;
