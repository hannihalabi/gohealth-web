-- Run inside a transaction and ROLLBACK. The summary must always equal a live count.
insert into auth.users(id) values ('13000000-0000-4000-8000-000000000001');
insert into clinical_private.patients(id,account_id,display_name,identity_label,identity_verified)
values ('43000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','Summary test','SUMMARY-TEST',true);
create function pg_temp.sum_assert(ok boolean,label text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'FAILED: %',label;end if;end$$;
create function pg_temp.sum_matches() returns boolean language sql as $$
  select coalesce(bool_and(s.n is not distinct from l.n and s.first_at is not distinct from l.first_at and s.last_at is not distinct from l.last_at), true)
  from (select kind,count(*) n,min(start_at) first_at,max(end_at) last_at from clinical_private.health_measurements
        where patient_id='43000000-0000-4000-8000-000000000001' and deleted_at is null group by kind) l
  full join (select * from clinical_private.health_kind_summary where patient_id='43000000-0000-4000-8000-000000000001') s using (kind)
$$;
insert into clinical_private.vitals(patient_id,source_id,kind,value,unit,start_at,end_at,source,definition)
values ('43000000-0000-4000-8000-000000000001','53000000-0000-4000-8000-000000000001','heart-rate',60,'beats/min','2026-01-01T00:00Z','2026-01-01T00:00Z','Synthetic','heart-rate');
insert into clinical_private.health_measurements(patient_id,source_id,kind,value,unit,start_at,end_at,source,definition,metadata)
select '43000000-0000-4000-8000-000000000001',
  case when g=1 then '53000000-0000-4000-8000-000000000001'::uuid else gen_random_uuid() end,
  case when g%2=0 then 'steps' else 'heart-rate' end, g,'unit',
  '2026-01-01T00:00Z'::timestamptz+g*interval '1 hour','2026-01-01T00:00Z'::timestamptz+g*interval '1 hour','Synthetic','d','{}'
from generate_series(1,40) g;
select pg_temp.sum_assert(pg_temp.sum_matches(),'summary equals live counts after insert');
select pg_temp.sum_assert((select superseded from clinical_private.vitals where source_id='53000000-0000-4000-8000-000000000001'),'legacy vital is flagged when a newer measurement arrives');
select pg_temp.sum_assert((select count(*)=40 from clinical_private.all_health_measurements where patient_id='43000000-0000-4000-8000-000000000001'),'view does not double a replaced legacy vital');
-- Delete the earliest and latest samples: bounds must move, not just the count.
update clinical_private.health_measurements set deleted_at=now()
where patient_id='43000000-0000-4000-8000-000000000001' and value in (1,39,40);
select pg_temp.sum_assert(pg_temp.sum_matches(),'summary equals live counts after soft delete of the extremes');
update clinical_private.health_measurements set deleted_at=now()
where patient_id='43000000-0000-4000-8000-000000000001' and kind='steps';
select pg_temp.sum_assert(not exists(select 1 from clinical_private.health_kind_summary where patient_id='43000000-0000-4000-8000-000000000001' and kind='steps'),'empty metric disappears');
delete from clinical_private.health_measurements where patient_id='43000000-0000-4000-8000-000000000001' and value=3;
select pg_temp.sum_assert(pg_temp.sum_matches(),'summary equals live counts after hard delete');
insert into clinical_private.vitals(patient_id,source_id,kind,value,unit,start_at,end_at,source,definition)
values ('43000000-0000-4000-8000-000000000001',(select source_id from clinical_private.health_measurements where value=5),'heart-rate',5,'beats/min','2026-01-01T05:00Z','2026-01-01T05:00Z','Synthetic','heart-rate');
select pg_temp.sum_assert((select superseded from clinical_private.vitals where value=5),'a late legacy vital with a known source is flagged on insert');
select 'Health summary: all assertions passed' as result;
