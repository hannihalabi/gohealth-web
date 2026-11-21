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
select public.gohealth_ingest_vitals_v2(jsonb_build_array(jsonb_build_object('source_id','51000000-0000-4000-8000-000000000001','kind','hrv','value',43.7,'unit','ms','definition','hrv','start_at','2010-01-01T12:00:00Z','end_at','2010-01-01T12:00:00Z','source','Synthetic','metadata',jsonb_build_object('user_entered',true))),'[]');
select public.gohealth_ingest_vitals_v2(jsonb_build_array(jsonb_build_object('source_id','51000000-0000-4000-8000-000000000001','kind','hrv','value',43.7,'unit','ms','definition','hrv','start_at','2010-01-01T12:00:00Z','end_at','2010-01-01T12:00:00Z','source','Synthetic','metadata',jsonb_build_object('user_entered',true))),'[]');
select pg_temp.history_reject($q$select public.clinician_vitals_v2('41000000-0000-4000-8000-000000000001')$q$);
do $$declare item jsonb;begin
 item:=jsonb_build_object('source_id',gen_random_uuid(),'kind','oxygen','value',97,'unit','ms','definition','oxygen','start_at','2010-01-01T12:00:00Z','end_at','2010-01-01T12:00:00Z','source','Synthetic');
 perform pg_temp.history_reject(format('select public.gohealth_ingest_vitals_v2(%L::jsonb,%L::jsonb)',jsonb_build_array(item),'[]'),'23514');
 item:=item||jsonb_build_object('unit','%','value',null);
 perform pg_temp.history_reject(format('select public.gohealth_ingest_vitals_v2(%L::jsonb,%L::jsonb)',jsonb_build_array(item),'[]'),'23514');
end$$;
reset role;
insert into clinical_private.vitals(patient_id,source_id,kind,value,unit,start_at,end_at,source,definition)
select '41000000-0000-4000-8000-000000000001',gen_random_uuid(),'hrv',50,'ms','2011-01-01T12:00Z','2011-01-01T12:00Z','Synthetic','hrv' from generate_series(1,650);
insert into clinical_private.vitals(patient_id,source_id,kind,value,unit,start_at,end_at,source,definition)
values ('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'sleep',null,'interval','2026-01-01T22:00Z','2026-01-02T02:00Z','Source A','asleep'),
('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'sleep',null,'interval','2026-01-02T00:00Z','2026-01-02T06:00Z','Source B','asleep-rem');
select pg_temp.history_claim(1);
set local role authenticated;
select pg_temp.history_assert((public.clinician_vitals_v2('41000000-0000-4000-8000-000000000001')->'metrics'->0->>'count')::int=651,'all-history count, old data and idempotent reimport');
select pg_temp.history_assert((public.clinician_vitals_v2('41000000-0000-4000-8000-000000000001')->'sleep_night'->>'seconds')::numeric=28800,'overlapping sleep counted once');
do $$declare result jsonb; cursor jsonb:=null; total int:=0; ids uuid[]:='{}'; sample jsonb;begin
 loop
  result:=public.clinician_vitals_v2('41000000-0000-4000-8000-000000000001','hrv',cursor);
  for sample in select value from jsonb_array_elements(result->'samples') loop
   if (sample->>'id')::uuid=any(ids) then raise exception 'Duplicate page entry';end if;
   ids:=array_append(ids,(sample->>'id')::uuid);total:=total+1;
   if sample->>'source_id'='51000000-0000-4000-8000-000000000001' then
     perform pg_temp.history_assert((sample->'metadata'->>'user_entered')::boolean,'manual provenance');
   end if;
  end loop;
  cursor:=nullif(result->'next','null');exit when cursor is null;
 end loop;
 perform pg_temp.history_assert(total=651,'pagination reaches 2010 without truncation');
end$$;
select pg_temp.history_claim(3);
select pg_temp.history_reject($q$select public.clinician_vitals_v2('41000000-0000-4000-8000-000000000001')$q$);
select pg_temp.history_claim(2);
select public.gohealth_ingest_vitals_v2('[]','["51000000-0000-4000-8000-000000000001"]');
select public.gohealth_ingest_vitals_v2(jsonb_build_array(jsonb_build_object('source_id','51000000-0000-4000-8000-000000000001','kind','hrv','value',43.7,'unit','ms','definition','hrv','start_at','2010-01-01T12:00:00Z','end_at','2010-01-01T12:00:00Z','source','Synthetic')),'[]');
select pg_temp.history_claim(1);
select pg_temp.history_assert((public.clinician_vitals_v2('41000000-0000-4000-8000-000000000001')->'metrics'->0->>'count')::int=650,'deletion propagated and tombstone not revived');
reset role;
update clinical_private.assignments set active=false where patient_id='41000000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.history_reject($q$select public.clinician_vitals_v2('41000000-0000-4000-8000-000000000001','hrv')$q$);
reset role;
update clinical_private.assignments set active=true where patient_id='41000000-0000-4000-8000-000000000001';
delete from auth.sessions where id='21000000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.history_reject($q$select public.clinician_vitals_v2('41000000-0000-4000-8000-000000000001')$q$);
reset role;
select 'Health history: all assertions passed' result;
