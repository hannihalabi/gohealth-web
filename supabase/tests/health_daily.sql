-- Run inside a transaction and ROLLBACK. The daily rollup must always equal a fresh computation.
insert into auth.users(id) values ('14000000-0000-4000-8000-000000000001');
insert into clinical_private.patients(id,account_id,display_name,identity_label,identity_verified)
values ('44000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001','Daily test','DAILY-TEST',true);
create function pg_temp.d_assert(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'FAILED: %',label;end if;end$$;
-- Fresh computation straight from the source view, same rules as the rollup.
create function pg_temp.d_matches() returns boolean language sql as $$
  with v as (
    select kind,(end_at at time zone 'Europe/Stockholm')::date as day,count(*)::int n,sum(value) total,min(value) lo,max(value) hi
    from clinical_private.all_health_measurements where patient_id='44000000-0000-4000-8000-000000000001' and value is not null group by 1,2
  ), i as (
    select kind,day,sum(extract(epoch from upper(x)-lower(x)))::double precision seconds from (
      select kind,((end_at at time zone 'Europe/Stockholm')-interval '12 hours')::date+1 as day,unnest(range_agg(tstzrange(start_at,end_at,'[)'))) x
      from clinical_private.all_health_measurements where patient_id='44000000-0000-4000-8000-000000000001' and value is null and end_at>start_at group by 1,2) r group by 1,2
  ), fresh as (
    select coalesce(v.kind,i.kind) kind,coalesce(v.day,i.day) as day,coalesce(v.n,0) n,v.total,v.lo,v.hi,i.seconds from v full join i using (kind,day)
  )
  select not exists (
    select kind,day,n,total,lo,hi,seconds from fresh
    except select kind,day,n,total,lo,hi,seconds from clinical_private.health_daily where patient_id='44000000-0000-4000-8000-000000000001'
  ) and not exists (
    select kind,day,n,total,lo,hi,seconds from clinical_private.health_daily where patient_id='44000000-0000-4000-8000-000000000001'
    except select kind,day,n,total,lo,hi,seconds from fresh
  )
$$;
-- A legacy vital, later replaced by a measurement with the same source.
insert into clinical_private.vitals(patient_id,source_id,kind,value,unit,start_at,end_at,source,definition)
values ('44000000-0000-4000-8000-000000000001','54000000-0000-4000-8000-000000000001','heart-rate',99,'beats/min','2026-03-01T10:00Z','2026-03-01T10:00Z','Synthetic','heart-rate');
select pg_temp.d_assert(pg_temp.d_matches(),'legacy vital is counted');
insert into clinical_private.health_measurements(patient_id,source_id,kind,value,unit,start_at,end_at,source,definition,metadata)
select '44000000-0000-4000-8000-000000000001',
  case when g=1 then '54000000-0000-4000-8000-000000000001'::uuid else gen_random_uuid() end,
  case when g%3=0 then 'steps' else 'heart-rate' end, 50+g,'unit',
  '2026-03-01T10:00Z'::timestamptz+g*interval '7 hours','2026-03-01T10:00Z'::timestamptz+g*interval '7 hours','Synthetic','d','{}'
from generate_series(1,60) g;
-- Two overlapping intervals across midnight count once for the night.
insert into clinical_private.health_measurements(patient_id,source_id,kind,value,unit,start_at,end_at,source,definition,metadata) values
 ('44000000-0000-4000-8000-000000000001',gen_random_uuid(),'sleep',null,'interval','2026-03-05T21:00Z','2026-03-06T03:00Z','Synthetic','d','{}'),
 ('44000000-0000-4000-8000-000000000001',gen_random_uuid(),'sleep',null,'interval','2026-03-05T23:00Z','2026-03-06T05:00Z','Synthetic','d','{}');
select pg_temp.d_assert(pg_temp.d_matches(),'rollup equals fresh computation after insert');
select pg_temp.d_assert((select n=1 and total=51 from clinical_private.health_daily where patient_id='44000000-0000-4000-8000-000000000001' and kind='heart-rate' and day='2026-03-01'),'replaced legacy vital is not counted twice');
select pg_temp.d_assert((select seconds=8*3600 from clinical_private.health_daily where patient_id='44000000-0000-4000-8000-000000000001' and kind='sleep' and day='2026-03-06'),'overlapping sleep merged to 8 h on the following day');
update clinical_private.health_measurements set deleted_at=now() where patient_id='44000000-0000-4000-8000-000000000001' and value in (52,53,60);
select pg_temp.d_assert(pg_temp.d_matches(),'rollup equals fresh computation after soft delete');
delete from clinical_private.health_measurements where patient_id='44000000-0000-4000-8000-000000000001' and value=55;
select pg_temp.d_assert(pg_temp.d_matches(),'rollup equals fresh computation after hard delete');
update clinical_private.vitals set deleted_at=now() where patient_id='44000000-0000-4000-8000-000000000001';
insert into clinical_private.health_sample_deletions(patient_id,source_id)
select patient_id,source_id from clinical_private.health_measurements where patient_id='44000000-0000-4000-8000-000000000001' and kind='sleep' limit 1;
update clinical_private.health_measurements set deleted_at=now() where patient_id='44000000-0000-4000-8000-000000000001' and kind='sleep' and source_id in (select source_id from clinical_private.health_sample_deletions);
select pg_temp.d_assert(pg_temp.d_matches(),'rollup equals fresh computation after tombstone');
select 'Health daily rollup tests passed: inserts, legacy replacement, merged sleep, soft and hard deletes, tombstones.' as result;
