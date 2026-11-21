-- Run inside a transaction and ROLLBACK; no email/API calls.
insert into auth.users(id) select ('11000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,3)n;
insert into auth.sessions(id,user_id) select ('21000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('11000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,3)n;
insert into clinical_private.organizations values('31000000-0000-4000-8000-000000000001','History test');
insert into clinical_private.staff(user_id,organization_id,display_name,role) values('11000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001','Doctor','doctor');
insert into clinical_private.patients(id,account_id,display_name,identity_label,identity_verified) values('41000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000002','History test','HISTORY-TEST',true);
insert into clinical_private.assignments(patient_id,organization_id,clinician_id) values('41000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001');
create function pg_temp.history_claim(n int) returns void language sql as $$select set_config('request.jwt.claims',jsonb_build_object('sub','11000000-0000-4000-8000-'||lpad(n::text,12,'0'),'aal','aal2','session_id','21000000-0000-4000-8000-'||lpad(n::text,12,'0'))::text,true)$$;
create function pg_temp.history_assert(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'FAILED: %',label;end if;end$$;
create function pg_temp.history_reject(q text,expected text default '42501') returns void language plpgsql as $$begin begin execute q;exception when others then if sqlstate=expected then return;else raise exception 'WRONG ERROR: % %',sqlstate,sqlerrm;end if;end;raise exception 'Unexpected access';end$$;

select pg_temp.history_claim(2);
set local role authenticated;
select public.gohealth_ingest_vitals_v2('[{"source_id":"52000000-0000-4000-8000-000000000001","kind":"heart-rate","value":60,"unit":"beats/min","definition":"heart-rate","start_at":"2000-01-01T00:00:00Z","end_at":"2000-01-01T00:00:00Z","source":"Synthetic"}]','[]');
select public.gohealth_sync_health_v3('[{"source_id":"52000000-0000-4000-8000-000000000001","kind":"heart-rate","value":60,"unit":"slag/min","definition":"heart-rate","start_at":"2000-01-01T00:00:00Z","end_at":"2000-01-01T00:00:00Z","source":"Synthetic","metadata":{"title":"Pulse","display_unit":"slag/min"}},{"source_id":"52000000-0000-4000-8000-000000000002","kind":"future.unlisted-metric","value":0,"unit":"new-unit","definition":"new-value","start_at":"1901-01-01T00:00:00Z","end_at":"1901-01-01T00:00:00Z","source":"Synthetic","metadata":{"title":"Future metric","display_unit":"new-unit","user_entered":true}}]','[]','[
 {"event_id":"62000000-0000-4000-8000-000000000001","key":"future-score","display_kind":"current","title":"Future score","section":"App","value":"A","unit":"","source":"Synthetic app","observed_at":"2026-01-01T00:00:00Z"},
 {"event_id":"62000000-0000-4000-8000-000000000002","key":"future-score","display_kind":"current","title":"Future score","section":"App","value":"B","unit":"","source":"Synthetic app","observed_at":"2026-01-01T00:00:00Z"},
 {"event_id":"62000000-0000-4000-8000-000000000003","key":"future-score","display_kind":"current","title":"Future score","section":"App","value":"A","unit":"","source":"Synthetic app","observed_at":"2026-01-01T00:00:00Z"},
 {"event_id":"62000000-0000-4000-8000-000000000004","key":"missing","display_kind":"current","title":"Missing reading","section":"App","value":"—","unit":"unit","source":"Unavailable","observed_at":"2026-01-01T00:00:00Z"}
]','syncing');
select pg_temp.history_reject($q$select public.clinician_health_v3('41000000-0000-4000-8000-000000000001')$q$);
select public.gohealth_sync_health_v3('[]','[]','[{"event_id":"62000000-0000-4000-8000-000000000003","key":"future-score","display_kind":"current","title":"Future score","section":"App","value":"A","unit":"","source":"Synthetic app","observed_at":"2026-01-01T00:00:00Z"}]','complete');
reset role;
insert into clinical_private.health_measurements(patient_id,source_id,kind,value,unit,start_at,end_at,source,definition,metadata)
select '41000000-0000-4000-8000-000000000001',gen_random_uuid(),'future.unlisted-metric',1,'new-unit','2001-01-01T00:00Z','2001-01-01T00:00Z','Synthetic','new-value','{"title":"Future metric"}' from generate_series(1,650);
select pg_temp.history_claim(1);
set local role authenticated;
select pg_temp.history_assert((select (value->>'count')::int=1 from jsonb_array_elements(public.clinician_health_v3('41000000-0000-4000-8000-000000000001')->'metrics') where value->>'kind'='heart-rate'),'reimport does not double legacy samples');
select pg_temp.history_assert((select (value->>'count')::int=651 from jsonb_array_elements(public.clinician_health_v3('41000000-0000-4000-8000-000000000001')->'metrics') where value->>'kind'='future.unlisted-metric'),'new unknown metric and zero values survive');
select pg_temp.history_assert((select value->>'value'='A' from jsonb_array_elements(public.clinician_health_v3('41000000-0000-4000-8000-000000000001')->'display_values') where value->>'key'='future-score'),'same-time A-B-A preserves latest value by received order');
select pg_temp.history_assert((select value->>'value'='—' from jsonb_array_elements(public.clinician_health_v3('41000000-0000-4000-8000-000000000001')->'display_values') where value->>'key'='missing'),'unavailable is not zero');
select pg_temp.history_assert(jsonb_array_length(public.clinician_health_v3('41000000-0000-4000-8000-000000000001','future-score',null,'display')->'samples')=3,'display retries are idempotent');
select pg_temp.history_assert(public.clinician_health_v3('41000000-0000-4000-8000-000000000001')->'sync'->>'state'='complete','sync state propagated');
do $$declare result jsonb; cursor jsonb:=null; n int:=0; ids uuid[]:='{}'; row jsonb;begin
 loop
  result:=public.clinician_health_v3('41000000-0000-4000-8000-000000000001','future.unlisted-metric',cursor,'raw');
  for row in select value from jsonb_array_elements(result->'samples') loop
   if (row->>'id')::uuid=any(ids) then raise exception 'Duplicate history row';end if;
   ids:=array_append(ids,(row->>'id')::uuid);n:=n+1;
  end loop;
  cursor:=nullif(result->'next','null');exit when cursor is null;
 end loop;
 perform pg_temp.history_assert(n=651,'all pages reach 1901');
end$$;
select pg_temp.history_claim(3);
select pg_temp.history_reject($q$select public.clinician_health_v3('41000000-0000-4000-8000-000000000001')$q$);
select pg_temp.history_reject($q$select public.gohealth_sync_health_v3('[]','[]','[]','complete')$q$);
select pg_temp.history_claim(2);
select public.gohealth_sync_health_v3('[]','["52000000-0000-4000-8000-000000000001","52000000-0000-4000-8000-000000000002"]','[]','syncing');
select public.gohealth_sync_health_v3('[{"source_id":"52000000-0000-4000-8000-000000000002","kind":"future.unlisted-metric","value":0,"unit":"new-unit","definition":"new-value","start_at":"1901-01-01T00:00:00Z","end_at":"1901-01-01T00:00:00Z","source":"Synthetic","metadata":{}}]','[]','[]','complete');
select pg_temp.history_claim(1);
select pg_temp.history_assert((select (value->>'count')::int=650 from jsonb_array_elements(public.clinician_health_v3('41000000-0000-4000-8000-000000000001')->'metrics') where value->>'kind'='future.unlisted-metric'),'deletions survive reimport');
select pg_temp.history_assert(not exists(select 1 from jsonb_array_elements(public.clinician_health_v3('41000000-0000-4000-8000-000000000001')->'metrics') where value->>'kind'='heart-rate'),'legacy and new raw copies both hidden after deletion');
reset role;
update clinical_private.assignments set active=false where patient_id='41000000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.history_reject($q$select public.clinician_health_v3('41000000-0000-4000-8000-000000000001','future.unlisted-metric',null,'raw')$q$);
reset role;
select 'Automatic sync tests passed: future metrics, 1901 history, zero/missing values, retries, recurrent changes, pagination, legacy deduplication, tombstones, sync state and care relation isolation.' result;
