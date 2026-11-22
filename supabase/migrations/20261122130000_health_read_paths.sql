-- Each table is read through its own ordered index with its own limit, instead of leaving the
-- union view to the planner, which on a large history sorted every sample (35 s for the overview).
drop index clinical_private.vitals_live;
create index vitals_live on clinical_private.vitals(patient_id, kind, end_at desc, id desc) where deleted_at is null and not superseded;

create or replace function clinical_private.automatic_health(action text,args jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=clinical_private.live_actor(); pid uuid; item jsonb; rows jsonb; metrics jsonb; displays jsonb; series jsonb; night jsonb; cursor_at timestamptz; cursor_id uuid; n int; state text; metric text; mode text;
begin
 delete from clinical_private.request_limits where actor_id=actor and bucket<date_trunc('minute',now())-interval '1 minute';
 insert into clinical_private.request_limits values(actor,date_trunc('minute',now()),1)
 on conflict(actor_id,bucket) do update set requests=clinical_private.request_limits.requests+1 returning requests into n;
 if n>120 then raise exception 'Request limit' using errcode='42501';end if;
 if action='ingest' then
  select id into pid from clinical_private.patients where account_id=actor and identity_verified;
  if pid is null then raise exception 'Verified patient account required' using errcode='42501';end if;
  if jsonb_typeof(args->'samples') is distinct from 'array' or jsonb_array_length(args->'samples')>500
    or jsonb_typeof(args->'deleted') is distinct from 'array' or jsonb_array_length(args->'deleted')>500
    or jsonb_typeof(args->'display') is distinct from 'array' or jsonb_array_length(args->'display')>200
  then raise exception 'Invalid batch' using errcode='22023';end if;
  state:=args->>'state';
  if state is null or state not in ('syncing','complete','retrying') then raise exception 'Invalid sync state' using errcode='22023';end if;
  for item in select value from jsonb_array_elements(args->'samples') loop
   if item->>'end_at' is null or item->>'start_at' is null or (item->>'end_at')::timestamptz>now()+interval '5 minutes'
     or (item->>'start_at') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' or (item->>'end_at') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
     or jsonb_typeof(item->'metadata') is distinct from 'object'
   then raise exception 'Invalid sample/time' using errcode='22023';end if;
   if not exists(select 1 from clinical_private.health_sample_deletions where patient_id=pid and source_id=(item->>'source_id')::uuid) then
    insert into clinical_private.health_measurements(patient_id,source_id,kind,value,unit,start_at,end_at,source,definition,metadata)
    values(pid,(item->>'source_id')::uuid,item->>'kind',(item->>'value')::double precision,item->>'unit',(item->>'start_at')::timestamptz,(item->>'end_at')::timestamptz,item->>'source',item->>'definition',item->'metadata')
    on conflict(patient_id,source_id) do nothing;
   end if;
  end loop;
  insert into clinical_private.health_sample_deletions(patient_id,source_id)
   select pid,value::uuid from jsonb_array_elements_text(args->'deleted') on conflict do nothing;
  update clinical_private.health_measurements set deleted_at=now() where patient_id=pid and source_id in(select value::uuid from jsonb_array_elements_text(args->'deleted')) and deleted_at is null;
  update clinical_private.vitals set deleted_at=now() where patient_id=pid and source_id in(select value::uuid from jsonb_array_elements_text(args->'deleted')) and deleted_at is null;
  for item in select value from jsonb_array_elements(args->'display') loop
   if item->>'observed_at' is null or (item->>'observed_at')::timestamptz>now()+interval '5 minutes'
     or (item->>'observed_at') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
     or (nullif(item->>'measured_at',''))::timestamptz>now()+interval '5 minutes'
   then raise exception 'Invalid display time' using errcode='22023';end if;
   insert into clinical_private.app_health_values(event_id,patient_id,key,display_kind,title,section,value,unit,source,record_id,measured_at,observed_at)
   values((item->>'event_id')::uuid,pid,item->>'key',item->>'display_kind',item->>'title',item->>'section',item->>'value',item->>'unit',item->>'source',item->>'record_id',nullif(item->>'measured_at','')::timestamptz,(item->>'observed_at')::timestamptz)
   on conflict(patient_id,event_id) do nothing;
  end loop;
  insert into clinical_private.health_sync_status(patient_id,state) values(pid,state)
   on conflict(patient_id) do update set state=excluded.state,updated_at=now();
  update clinical_private.patients set last_sync_at=now() where id=pid;
  insert into clinical_private.audit(actor_id,patient_id,action) values(actor,pid,'patient.sync_all_app_values');
  return jsonb_build_object('ok',true);
 end if;
 pid:=(args->>'patient')::uuid;
 if not clinical_private.portal_assurance_sufficient() or not exists(
  select 1 from clinical_private.assignments a join clinical_private.staff s on s.user_id=a.clinician_id and s.organization_id=a.organization_id
  where a.patient_id=pid and a.clinician_id=actor and a.active and s.active
 ) then raise exception 'Active clinical care relation required' using errcode='42501';end if;
 mode:=coalesce(args->>'mode','overview');metric:=args->>'kind';
 if mode='overview' then
  select coalesce(jsonb_agg(jsonb_build_object('kind',g.kind,'count',g.n,'first_at',g.first_at,'last_at',g.last_at,'latest',
   (select to_jsonb(v)-'patient_id' from (
    (select m.id,m.patient_id,m.source_id,m.kind,m.value,m.unit,m.start_at,m.end_at,m.source,m.definition,m.metadata,m.received_at
     from clinical_private.health_measurements m where m.patient_id=pid and m.kind=g.kind and m.deleted_at is null order by m.end_at desc,m.id desc limit 1)
    union all
    (select w.id,w.patient_id,w.source_id,w.kind,w.value,w.unit,w.start_at,w.end_at,w.source,w.definition,w.metadata,w.received_at
     from clinical_private.vitals w where w.patient_id=pid and w.kind=g.kind and w.deleted_at is null and not w.superseded
     and not exists(select 1 from clinical_private.health_sample_deletions d where d.patient_id=w.patient_id and d.source_id=w.source_id)
     order by w.end_at desc,w.id desc limit 1)
   ) v order by v.end_at desc,v.id desc limit 1)) order by g.kind),'[]') into metrics
  from (select x.kind,sum(x.n)::bigint n,min(x.first_at) first_at,max(x.last_at) last_at from (
    select k.kind,k.n,k.first_at,k.last_at from clinical_private.health_kind_summary k where k.patient_id=pid and k.n>0
    union all
    select v.kind,count(*),min(v.start_at),max(v.end_at) from clinical_private.vitals v
    where v.patient_id=pid and v.deleted_at is null and not v.superseded
      and not exists(select 1 from clinical_private.health_sample_deletions d where d.patient_id=v.patient_id and d.source_id=v.source_id)
    group by v.kind) x(kind,n,first_at,last_at) group by x.kind) g;
  select coalesce(jsonb_agg(to_jsonb(v)-'patient_id' order by v.section,v.title),'[]') into displays from (
   select distinct on (key) * from clinical_private.app_health_values where patient_id=pid and display_kind='current' order by key,received_order desc
  ) v;
  select coalesce(jsonb_agg(jsonb_build_object('key',key,'count',v.n,'first_at',first_at,'last_at',last_at,'title',title)),'[]') into series
  from (select key,count(*) n,min(coalesce(measured_at,observed_at)) first_at,max(coalesce(measured_at,observed_at)) last_at,max(title) title
   from clinical_private.app_health_values where patient_id=pid group by key) v;
  with latest as (
   select ((max(end_at) at time zone 'Europe/Stockholm')-interval '12 hours'-interval '1 microsecond')::date night_day from clinical_private.all_health_measurements where patient_id=pid and kind='sleep'
  ), bounds as (
   select night_day,(night_day+time '12:00') at time zone 'Europe/Stockholm' lo,((night_day+1)+time '12:00') at time zone 'Europe/Stockholm' hi from latest where night_day is not null
  ), merged as (
   select b.night_day,range_agg(tstzrange(greatest(v.start_at,b.lo),least(v.end_at,b.hi),'[)')) spans from bounds b
   join clinical_private.all_health_measurements v on v.patient_id=pid and v.kind='sleep' and v.start_at<b.hi and v.end_at>b.lo group by b.night_day
  ) select jsonb_build_object('day',night_day+1,'seconds',(select sum(extract(epoch from upper(x)-lower(x))) from unnest(spans) x)) into night from merged;
  insert into clinical_private.audit(actor_id,patient_id,action) values(actor,pid,'patient.all_app_values_overview');
  return jsonb_build_object('metrics',metrics,'display_values',displays,'display_series',series,'sleep_night',night,'sync',
   (select jsonb_build_object('state',s.state,'updated_at',s.updated_at) from clinical_private.health_sync_status s where s.patient_id=pid));
 end if;
 if mode not in ('raw','display') or metric is null or length(metric) not between 1 and 200 then raise exception 'Invalid history request' using errcode='22023';end if;
 if args->'cursor' is not null and args->'cursor'<>'null'::jsonb then
  cursor_at:=(args->'cursor'->>'at')::timestamptz;cursor_id:=(args->'cursor'->>'id')::uuid;
  if cursor_at is null or cursor_id is null then raise exception 'Invalid cursor' using errcode='22023';end if;
 end if;
 if mode='raw' then
  select coalesce(jsonb_agg(to_jsonb(v)-'patient_id' order by v.end_at desc,v.id desc),'[]') into rows from (
   (select m.id,m.patient_id,m.source_id,m.kind,m.value,m.unit,m.start_at,m.end_at,m.source,m.definition,m.metadata,m.received_at
    from clinical_private.health_measurements m where m.patient_id=pid and m.kind=metric and m.deleted_at is null
     and (m.end_at,m.id)<(coalesce(cursor_at,'infinity'::timestamptz),coalesce(cursor_id,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)) order by m.end_at desc,m.id desc limit 201)
   union all
   (select w.id,w.patient_id,w.source_id,w.kind,w.value,w.unit,w.start_at,w.end_at,w.source,w.definition,w.metadata,w.received_at
    from clinical_private.vitals w where w.patient_id=pid and w.kind=metric and w.deleted_at is null and not w.superseded
     and not exists(select 1 from clinical_private.health_sample_deletions d where d.patient_id=w.patient_id and d.source_id=w.source_id)
     and (w.end_at,w.id)<(coalesce(cursor_at,'infinity'::timestamptz),coalesce(cursor_id,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)) order by w.end_at desc,w.id desc limit 201)
   order by end_at desc,id desc limit 201
  ) v;
 else
  select coalesce(jsonb_agg(to_jsonb(v)-'patient_id' order by v.end_at desc,v.id desc),'[]') into rows from (
   select a.*,a.event_id id,a.observed_at end_at from clinical_private.app_health_values a where patient_id=pid and key=metric
   and (cursor_at is null or (observed_at,event_id)<(cursor_at,cursor_id)) order by observed_at desc,event_id desc limit 201
  ) v;
 end if;
 insert into clinical_private.audit(actor_id,patient_id,action) values(actor,pid,'patient.read_all_app_values');
 return jsonb_build_object('samples',case when jsonb_array_length(rows)>200 then rows-200 else rows end,
  'next',case when jsonb_array_length(rows)>200 then jsonb_build_object('at',rows->199->>'end_at','id',rows->199->>'id') else null end);
end $$;
