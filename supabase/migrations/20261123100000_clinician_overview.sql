-- Clinician overview: every active doctor in a clinic may open every patient in that clinic.
-- Assignment still defines the doctor's own patient pool (continuity, deviations) and is required for nurses.
-- Every opening is logged in clinical_private.audit as before.
create function clinical_private.care_organization(p_actor uuid, p_patient uuid) returns uuid
language sql stable set search_path = pg_catalog as $$
  select coalesce(
    (select a.organization_id from clinical_private.assignments a
       join clinical_private.staff s on s.user_id = a.clinician_id and s.organization_id = a.organization_id
      where a.patient_id = p_patient and a.clinician_id = p_actor and a.active and s.active
      order by a.organization_id limit 1),
    (select op.organization_id from clinical_private.organization_patients op
       join clinical_private.staff s on s.organization_id = op.organization_id
      where op.patient_id = p_patient and op.active and s.user_id = p_actor and s.active and s.role = 'doctor'
      order by op.organization_id limit 1))
$$;
revoke all on function clinical_private.care_organization(uuid, uuid) from public, anon, authenticated;

create or replace function clinical_private.ct_archive_organization(p_actor uuid, p_patient uuid) returns uuid
language sql stable set search_path = pg_catalog as $$select clinical_private.care_organization(p_actor, p_patient)$$;

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
 if not clinical_private.portal_assurance_sufficient() or clinical_private.care_organization(actor, pid) is null then raise exception 'Active clinical care relation required' using errcode='42501';end if;
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

create or replace function clinical_private.health_history(action text,args jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=clinical_private.live_actor(); pid uuid; item jsonb; sample_kind text; n integer; rows jsonb; cursor_at timestamptz; cursor_id uuid; night jsonb;
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
   then raise exception 'Batch size' using errcode='22023';end if;
   for item in select value from jsonb_array_elements(args->'samples') loop
     if item->>'source_id' is null or jsonb_typeof(item->'kind') is distinct from 'string'
       or jsonb_typeof(item->'source') is distinct from 'string' or item->>'start_at' is null or item->>'end_at' is null
       or (item->>'end_at')::timestamptz>now()+interval '5 minutes'
       or (item->>'start_at') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
       or (item->>'end_at') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
     then raise exception 'Invalid sample/time' using errcode='22023';end if;
     insert into clinical_private.vitals(patient_id,source_id,kind,value,unit,start_at,end_at,source,definition,calendar_day,metadata)
     values(pid,(item->>'source_id')::uuid,item->>'kind',(item->>'value')::double precision,item->>'unit',
       (item->>'start_at')::timestamptz,(item->>'end_at')::timestamptz,item->>'source',item->>'definition',(item->>'calendar_day')::date,coalesce(item->'metadata','{}'))
     on conflict(patient_id,source_id) do update set metadata=excluded.metadata,definition=excluded.definition,
       value=case when excluded.kind='steps' then excluded.value else clinical_private.vitals.value end,
       end_at=case when excluded.kind='steps' then excluded.end_at else clinical_private.vitals.end_at end
       where clinical_private.vitals.deleted_at is null and clinical_private.vitals.kind=excluded.kind
       and clinical_private.vitals.start_at=excluded.start_at and (
         (excluded.kind='steps' and clinical_private.vitals.calendar_day=excluded.calendar_day and clinical_private.vitals.end_at<=excluded.end_at)
         or (clinical_private.vitals.end_at=excluded.end_at and clinical_private.vitals.value is not distinct from excluded.value));
   end loop;
   update clinical_private.vitals set deleted_at=now() where patient_id=pid and source_id in(select value::uuid from jsonb_array_elements_text(args->'deleted')) and deleted_at is null;
   update clinical_private.patients set last_sync_at=now() where id=pid;
   insert into clinical_private.audit(actor_id,patient_id,action) values(actor,pid,'patient.sync_health_history');
   return jsonb_build_object('ok',true);
 end if;
 pid:=(args->>'patient')::uuid;
 if not clinical_private.portal_assurance_sufficient() or clinical_private.care_organization(actor, pid) is null then raise exception 'Active clinical care relation required' using errcode='42501';end if;
 if action='overview' then
   select coalesce(jsonb_agg(jsonb_build_object('kind',g.kind,'count',g.n,'first_at',g.first_at,'last_at',g.last_at,'latest',
     (select to_jsonb(v)-'patient_id' from clinical_private.vitals v where v.patient_id=pid and v.kind=g.kind and v.deleted_at is null order by v.end_at desc,v.id desc limit 1)) order by g.kind),'[]') into rows
   from (select kind,count(*) n,min(start_at) first_at,max(end_at) last_at from clinical_private.vitals where patient_id=pid and deleted_at is null group by kind) g;
   -- Noon-to-noon Swedish nights; union ranges before summing across devices.
   with latest as (
     select ((max(end_at) at time zone 'Europe/Stockholm')-interval '12 hours'-interval '1 microsecond')::date as night_day
     from clinical_private.vitals where patient_id=pid and kind='sleep' and deleted_at is null
   ), bounds as (
     select night_day, (night_day+time '12:00') at time zone 'Europe/Stockholm' lo,
       ((night_day+1)+time '12:00') at time zone 'Europe/Stockholm' hi from latest where night_day is not null
   ), merged as (
     select b.night_day,range_agg(tstzrange(greatest(v.start_at,b.lo),least(v.end_at,b.hi),'[)')) spans
     from bounds b join clinical_private.vitals v on v.patient_id=pid and v.kind='sleep' and v.deleted_at is null
       and v.start_at<b.hi and v.end_at>b.lo group by b.night_day
   ) select jsonb_build_object('day',night_day+1,'seconds',(select sum(extract(epoch from upper(x)-lower(x))) from unnest(spans) x)) into night from merged;
   insert into clinical_private.audit(actor_id,patient_id,action) values(actor,pid,'patient.health_history_overview');
   return jsonb_build_object('metrics',rows,'sleep_night',night);
 elsif action='page' then
   sample_kind:=args->>'kind';
   if sample_kind is null or sample_kind not in ('heart-rate','resting-heart-rate','sleep','steps','step-count','hrv','hrv-rmssd','respiratory-rate','oxygen','vo2-max','weight','temperature','fev1','fvc','pef','distance','active-energy','flights','sleep-awake','sleep-in-bed','workout') then raise exception 'Invalid metric' using errcode='22023';end if;
   if args->'cursor' is not null and args->'cursor'<>'null'::jsonb then
     cursor_at:=(args->'cursor'->>'at')::timestamptz;cursor_id:=(args->'cursor'->>'id')::uuid;
     if cursor_at is null or cursor_id is null then raise exception 'Invalid cursor' using errcode='22023';end if;
   end if;
   select coalesce(jsonb_agg(to_jsonb(v)-'patient_id' order by v.end_at desc,v.id desc),'[]') into rows
   from (select * from clinical_private.vitals where patient_id=pid and kind=sample_kind and deleted_at is null
     and (cursor_at is null or (end_at,id)<(cursor_at,cursor_id)) order by end_at desc,id desc limit 201) v;
   insert into clinical_private.audit(actor_id,patient_id,action) values(actor,pid,'patient.read_health_history');
   return jsonb_build_object('samples',case when jsonb_array_length(rows)>200 then rows-200 else rows end,
     'next',case when jsonb_array_length(rows)>200 then jsonb_build_object('at',rows->199->>'end_at','id',rows->199->>'id') else null end);
 end if;
 raise exception 'Invalid action' using errcode='22023';
end $$;

create or replace function clinical_private.health_trend(p_patient uuid, p_days integer, p_bucket text default 'day') returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  actor uuid := clinical_private.live_actor();
  n integer;
  since date;
  result jsonb;
begin
  if not clinical_private.portal_assurance_sufficient() or clinical_private.care_organization(actor, p_patient) is null then raise exception 'Active clinical care relation required' using errcode = '42501'; end if;
  if p_bucket is null or p_bucket not in ('day', 'week', 'month') or p_days is null or p_days < 1
    or (p_bucket = 'day' and p_days > 366) or (p_bucket = 'week' and p_days > 3700) or p_days > 40000
  then raise exception 'Invalid trend range' using errcode = '22023'; end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  since := (now() at time zone 'Europe/Stockholm')::date - (p_days - 1);

  select coalesce(jsonb_agg(to_jsonb(t) order by t.kind, t.day), '[]'::jsonb) into result from (
    select d.kind, case when p_bucket = 'day' then d.day else date_trunc(p_bucket, d.day::timestamp)::date end as day,
      sum(d.total) / sum(d.n) as avg, min(d.lo) as min, max(d.hi) as max, sum(d.total) / count(*) as sum,
      sum(d.n)::int as n, count(*)::int as days
    from clinical_private.health_daily d
    where d.patient_id = p_patient and d.day >= since and d.n > 0 group by 1, 2
    union all
    select d.kind, case when p_bucket = 'day' then d.day else date_trunc(p_bucket, d.day::timestamp)::date end,
      null::double precision, null::double precision, null::double precision, avg(d.seconds), null::int, count(*)::int
    from clinical_private.health_daily d
    where d.patient_id = p_patient and d.day >= since and d.seconds is not null group by 1, 2
  ) t;
  insert into clinical_private.audit (actor_id, patient_id, action) values (actor, p_patient, 'patient.read_health_trend');
  return jsonb_build_object('days', p_days, 'bucket', p_bucket, 'series', result);
end $$;

create or replace function clinical_private.gateway(action text,args jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=auth.uid(); pid uuid; org uuid; sid uuid; v_payload jsonb; old clinical_private.records;
 rec clinical_private.records; pat clinical_private.patients; result jsonb; n integer; item jsonb; r integer; v_kind text;
begin
 if actor is null or not exists(select 1 from auth.users u where u.id=actor and (u.banned_until is null or u.banned_until<now()))
 or not exists(select 1 from auth.sessions s where s.id=(auth.jwt()->>'session_id')::uuid and s.user_id=actor and (s.not_after is null or s.not_after>now())) then raise exception 'Valid session required' using errcode='42501';end if;
 if action='session' then
   select jsonb_build_object('staff',true,'name',s.display_name,'role',s.role,'aal',auth.jwt()->>'aal') into result
   from clinical_private.staff s where s.user_id=actor and s.active order by (s.role='doctor') desc,s.organization_id limit 1;
   return coalesce(result,jsonb_build_object('staff',false));
 end if;
 -- Bounded DB-side request limiter across all API instances. Expired rows are removed.
 delete from clinical_private.request_limits where actor_id=actor and bucket<date_trunc('minute',now())-interval '1 minute';
 insert into clinical_private.request_limits values(actor,date_trunc('minute',now()),1)
 on conflict(actor_id,bucket) do update set requests=clinical_private.request_limits.requests+1 returning requests into n;
 if n>120 then raise exception 'Request limit' using errcode='42501';end if;
 if action in ('patient_data','ingest') then
   select * into pat from clinical_private.patients where account_id=actor and identity_verified;
   if pat.id is null then raise exception 'Verified patient account required' using errcode='42501';end if;pid:=pat.id;
   if action='patient_data' then
     insert into clinical_private.audit(actor_id,patient_id,action) values(actor,pid,'patient.read_published');
     return jsonb_build_object('records',coalesce((select jsonb_agg(to_jsonb(x)-'created_by'-'published_by'-'organization_id') from
     (select * from clinical_private.records where patient_id=pid and status='published' and superseded_at is null order by published_at desc limit 500) x),'[]'::jsonb));
   end if;
   if jsonb_typeof(args->'samples') is distinct from 'array' or jsonb_array_length(args->'samples')>500 or jsonb_typeof(args->'deleted') is distinct from 'array' or jsonb_array_length(args->'deleted')>500 then raise exception 'Batch size' using errcode='22023';end if;
   for item in select value from jsonb_array_elements(args->'samples') loop
     v_kind:=item->>'kind';
     if coalesce(v_kind,'') not in ('heart-rate','resting-heart-rate','sleep','steps') or jsonb_typeof(item->'source') is distinct from 'string' then raise exception 'Invalid sample' using errcode='22023';end if;
     if (item->>'end_at')::timestamptz>now()+interval '5 minutes' or (item->>'definition') is distinct from
       (case v_kind when 'sleep' then 'asleep' when 'steps' then 'steps-daily' else v_kind end) then raise exception 'Invalid definition/time' using errcode='22023';end if;
     insert into clinical_private.vitals(patient_id,source_id,kind,value,unit,start_at,end_at,source,definition,calendar_day)
     values(pid,(item->>'source_id')::uuid,v_kind,(item->>'value')::double precision,item->>'unit',(item->>'start_at')::timestamptz,(item->>'end_at')::timestamptz,item->>'source',item->>'definition',(item->>'calendar_day')::date)
     on conflict(patient_id,source_id) do update
     set value=excluded.value,start_at=excluded.start_at,end_at=excluded.end_at,received_at=now(),deleted_at=null
     where clinical_private.vitals.kind='steps' and excluded.kind='steps'
       and clinical_private.vitals.calendar_day=excluded.calendar_day
       and clinical_private.vitals.end_at<=excluded.end_at;
   end loop;
   update clinical_private.vitals set deleted_at=now() where patient_id=pid and source_id in(select value::uuid from jsonb_array_elements_text(args->'deleted')) and deleted_at is null;
   update clinical_private.patients set last_sync_at=now() where id=pid;
   insert into clinical_private.audit(actor_id,patient_id,action) values(actor,pid,'patient.sync_vitals');
   return jsonb_build_object('ok',true);
 end if;
 if not clinical_private.portal_assurance_sufficient() then
   raise exception 'Staff authentication required' using errcode='42501';
 end if;
 if not exists(select 1 from clinical_private.staff where user_id=actor and active) then
   raise exception 'Active staff membership required' using errcode='42501';
 end if;
 if action='list' then
   if length(coalesce(args->>'query',''))>120 then raise exception 'Query too long' using errcode='22023';end if;
   insert into clinical_private.audit(actor_id,action) values(actor,'patient.search');
   return coalesce((select jsonb_agg(to_jsonb(x)) from (select p.id,p.display_name,p.identity_label,p.identity_verified,p.last_sync_at from clinical_private.patients p
     where exists(select 1 from clinical_private.assignments a join clinical_private.staff s on s.user_id=a.clinician_id and s.organization_id=a.organization_id
       where a.patient_id=p.id and a.clinician_id=actor and a.active and s.active)
     and (coalesce(args->>'query','')='' or p.identity_label=args->>'query' or position(lower(args->>'query') in lower(p.display_name))>0)
     order by p.display_name,p.id limit 100) x),'[]'::jsonb);
 end if;
 if action in ('patient','save','vital_history') then pid:=(args->>'patient')::uuid;
 elsif action='publish' then select patient_id into pid from clinical_private.records where id=(args->>'id')::uuid;
 else raise exception 'Unknown action' using errcode='22023';end if;
 org:=clinical_private.care_organization(actor,pid);
 if org is null then raise exception 'Active care relation required' using errcode='42501';end if;
 if action='vital_history' then
   v_kind:=args->>'kind';
   if coalesce(v_kind,'') not in ('heart-rate','resting-heart-rate','sleep','steps')
     or args->>'before_at' is null or args->>'before_id' is null then
     raise exception 'Invalid history cursor' using errcode='22023';
   end if;
   insert into clinical_private.audit(actor_id,patient_id,action) values(actor,pid,'patient.open_vital_history');
   return coalesce((select jsonb_agg(to_jsonb(x)-'patient_id'-'source_id' order by x.end_at desc,x.id desc)
     from (select * from clinical_private.vitals v
       where v.patient_id=pid and v.kind=v_kind and v.deleted_at is null
         and (v.end_at,v.id)<((args->>'before_at')::timestamptz,(args->>'before_id')::uuid)
       order by v.end_at desc,v.id desc limit 100) x),'[]'::jsonb);
 end if;
 if action='patient' then
   insert into clinical_private.audit(actor_id,patient_id,action) values(actor,pid,'patient.open');
   return jsonb_build_object(
     'patient',(select jsonb_build_object('id',id,'display_name',display_name,'identity_label',identity_label,'identity_verified',identity_verified,'last_sync_at',last_sync_at) from clinical_private.patients where id=pid),
     'records',coalesce((select jsonb_agg(to_jsonb(x)-'created_by'-'published_by'-'organization_id') from(select * from clinical_private.records where patient_id=pid and organization_id=org order by created_at desc limit 500)x),'[]'::jsonb),
     'vitals',coalesce((select jsonb_agg(to_jsonb(x)-'patient_id'-'source_id' order by x.end_at desc,x.id desc)
       from (values ('heart-rate'),('resting-heart-rate'),('sleep'),('steps')) as metric(kind)
       cross join lateral (select * from clinical_private.vitals v
         where v.patient_id=pid and v.kind=metric.kind and v.deleted_at is null
         order by v.end_at desc,v.id desc limit 100) x),'[]'::jsonb),
     'audit',coalesce((select jsonb_agg(to_jsonb(x)) from(select a.action,a.created_at from clinical_private.audit a where a.patient_id=pid and a.actor_id=actor order by a.created_at desc,a.id desc limit 50)x),'[]'::jsonb));
 end if;
 if action='save' then
   v_payload:=args->'payload';v_kind:=args->>'kind';perform clinical_private.validate_payload(v_kind,v_payload);
   if v_kind='imaging' and coalesce(v_payload->>'studyId','')<>'' and not exists(select 1 from public.imaging_studies i join public.imaging_patients ip on ip.id=i.patient_id join clinical_private.patients p on p.account_id=ip.owner_id where p.id=pid and i.id=(v_payload->>'studyId')::uuid) then raise exception 'Study does not belong to patient' using errcode='42501';end if;
   sid:=nullif(args->>'id','')::uuid;r:=(args->>'revision')::integer;
   if sid is not null then
     select * into old from clinical_private.records where id=sid and patient_id=pid and organization_id=org for update;
     if old.id is null or old.status<>'draft' or old.kind<>v_kind then raise exception 'Draft access denied' using errcode='42501';end if;
     if r is null or old.revision<>r then raise exception 'Revision conflict' using errcode='40001';end if;
     if old.replaces_id is not null and length(btrim(coalesce(args->>'reason',''))) not between 1 and 500 then raise exception 'Correction reason required' using errcode='22023';end if;
     update clinical_private.records cr set payload=v_payload,revision=cr.revision+1,correction_reason=case when cr.replaces_id is null then null else btrim(args->>'reason') end where cr.id=sid returning * into rec;
   else
     if r is null or r<>0 then raise exception 'Invalid initial revision' using errcode='40001';end if;
     if nullif(args->>'replaces','') is not null then
       select cr.* into old from clinical_private.records cr where cr.id=(args->>'replaces')::uuid and cr.patient_id=pid and cr.organization_id=org and cr.kind=v_kind and cr.status='published' and cr.superseded_at is null for update;
       if old.id is null then raise exception 'Original unavailable' using errcode='40001';end if;
     end if;
     insert into clinical_private.records(patient_id,organization_id,kind,payload,replaces_id,version,correction_reason,created_by)
     values(pid,org,v_kind,v_payload,old.id,coalesce(old.version+1,1),nullif(btrim(args->>'reason'),''),actor) returning * into rec;
   end if;
   insert into clinical_private.audit(actor_id,patient_id,action,record_id) values(actor,pid,'record.save_draft',rec.id);
   return to_jsonb(rec)-'created_by'-'published_by'-'organization_id';
 end if;
 if action='publish' then
   if not exists(select 1 from clinical_private.staff where user_id=actor and organization_id=org and active and role='doctor') or not exists(select 1 from clinical_private.patients where id=pid and identity_verified and account_id is not null) then raise exception 'Verified patient and doctor required' using errcode='42501';end if;
   -- Serialize publication for this patient, including competing corrections.
   perform pg_advisory_xact_lock(hashtextextended(pid::text,0));
   select * into rec from clinical_private.records where id=(args->>'id')::uuid and patient_id=pid and organization_id=org for update;
   if rec.id is null then raise exception 'Record unavailable' using errcode='42501';end if;
   if (args->>'revision') is null or rec.revision<>(args->>'revision')::integer or rec.status<>'draft' then raise exception 'Revision conflict' using errcode='40001';end if;
   if rec.replaces_id is not null then
     update clinical_private.records set superseded_at=now() where id=rec.replaces_id and patient_id=pid and organization_id=org and status='published' and superseded_at is null;
     get diagnostics n=row_count;if n<>1 then raise exception 'Original already corrected' using errcode='40001';end if;
   end if;
   update clinical_private.records set status='published',published_by=actor,published_at=now(),revision=revision+1 where id=rec.id;
   insert into clinical_private.audit(actor_id,patient_id,action,record_id) values(actor,pid,'record.publish',rec.id);
   return jsonb_build_object('ok',true);
 end if;
 raise exception 'Unhandled action' using errcode='22023';
end $$;

create or replace function clinical_private.patient_directory(p_query text, p_scope text) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  actor uuid := clinical_private.live_actor();
  n integer;
begin
  if not clinical_private.portal_assurance_sufficient() then
    raise exception 'Staff authentication required' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('mine', 'all') or length(coalesce(p_query, '')) > 120 then
    raise exception 'Invalid directory request' using errcode = '22023';
  end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.display_name, x.id) from (
    select p.id, p.display_name, p.identity_label, p.identity_verified, p.last_sync_at,
      exists (select 1 from clinical_private.assignments a
        join clinical_private.staff s on s.user_id = a.clinician_id and s.organization_id = a.organization_id
        where a.patient_id = p.id and a.organization_id = op.organization_id and a.clinician_id = actor and a.active and s.active) as assigned_to_me,
      clinical_private.care_organization(actor, p.id) is not null as can_open,
      coalesce((select jsonb_agg(s2.display_name order by s2.display_name) from clinical_private.assignments a2
        join clinical_private.staff s2 on s2.user_id = a2.clinician_id and s2.organization_id = a2.organization_id
        where a2.patient_id = p.id and a2.organization_id = op.organization_id and a2.active and s2.active and s2.role = 'doctor'), '[]'::jsonb) as doctors
    from clinical_private.organization_patients op
    join clinical_private.patients p on p.id = op.patient_id
    where op.active
      and exists (select 1 from clinical_private.staff s where s.user_id = actor and s.organization_id = op.organization_id and s.active)
      and (p_scope = 'all' or exists (select 1 from clinical_private.assignments a
        join clinical_private.staff s on s.user_id = a.clinician_id and s.organization_id = a.organization_id
        where a.patient_id = p.id and a.organization_id = op.organization_id and a.clinician_id = actor and a.active and s.active))
      and (coalesce(p_query, '') = '' or p.identity_label = p_query or position(lower(p_query) in lower(p.display_name)) > 0)
    order by p.display_name, p.id limit 200) x), '[]'::jsonb);
end $$;

create or replace function clinical_private.pending_attestations() returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  actor uuid := clinical_private.live_actor();
  n integer;
begin
  if not clinical_private.portal_assurance_sufficient() then
    raise exception 'Staff authentication required' using errcode = '42501';
  end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
    select r.id, r.patient_id, p.display_name, p.identity_label, p.identity_verified, r.kind, r.version, r.revision,
      r.replaces_id is not null as is_correction, r.created_at,
      jsonb_strip_nulls(jsonb_build_object('title', r.payload->>'title', 'sampledAt', r.payload->>'sampledAt',
        'modality', r.payload->>'modality', 'bodyPart', r.payload->>'bodyPart', 'vaccine', r.payload->>'vaccine')) as payload,
      (select s2.display_name from clinical_private.staff s2 where s2.user_id = r.created_by and s2.organization_id = r.organization_id) as created_by_name
    from clinical_private.records r
    join clinical_private.patients p on p.id = r.patient_id
    join clinical_private.staff s on s.user_id = actor and s.organization_id = r.organization_id and s.active
    where r.status = 'draft' and r.superseded_at is null
      -- Drafts for my own patients and drafts I wrote myself, also for patients outside my pool.
      and (r.created_by = actor or exists (select 1 from clinical_private.assignments a
        where a.patient_id = r.patient_id and a.organization_id = r.organization_id and a.clinician_id = actor and a.active))
    order by r.created_at desc limit 200) x), '[]'::jsonb);
end $$;
-- Announcements from the administrator to every staff member in the clinic.
create table clinical_private.staff_announcements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_private.organizations,
  title text not null check (length(btrim(title)) between 1 and 120),
  body text not null check (length(btrim(body)) between 1 and 2000),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  archived_at timestamptz, archived_by uuid references auth.users(id),
  check ((archived_at is null) = (archived_by is null))
);
create index staff_announcements_live on clinical_private.staff_announcements(organization_id, created_at desc) where archived_at is null;
alter table clinical_private.staff_announcements enable row level security;
revoke all on clinical_private.staff_announcements from public, anon, authenticated;

create function clinical_private.announcements_admin(org uuid, p_action text, args jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor(); n integer; item clinical_private.staff_announcements; expires timestamptz;
begin
  if not clinical_private.portal_assurance_sufficient() or not exists (
    select 1 from clinical_private.administrators where user_id = actor and organization_id = org and active
  ) then raise exception 'Administrator required' using errcode = '42501'; end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  if p_action = 'post' then
    expires := nullif(args->>'expires_at', '')::timestamptz;
    if length(btrim(coalesce(args->>'title', ''))) not between 1 and 120 or length(btrim(coalesce(args->>'body', ''))) not between 1 and 2000
      or (expires is not null and (expires <= now() or expires > now() + interval '366 days'))
    then raise exception 'Invalid announcement' using errcode = '22023'; end if;
    insert into clinical_private.staff_announcements (organization_id, title, body, created_by, expires_at)
    values (org, btrim(args->>'title'), btrim(args->>'body'), actor, expires) returning * into item;
    insert into clinical_private.administration_audit (organization_id, actor_id, action, subject_id) values (org, actor, 'announcement.post', item.id);
  elsif p_action = 'archive' then
    update clinical_private.staff_announcements set archived_at = now(), archived_by = actor
    where id = (args->>'id')::uuid and organization_id = org and archived_at is null returning * into item;
    if item.id is null then raise exception 'Announcement unavailable' using errcode = '40001'; end if;
    insert into clinical_private.administration_audit (organization_id, actor_id, action, subject_id) values (org, actor, 'announcement.archive', item.id);
  elsif p_action is distinct from 'list' then raise exception 'Invalid action' using errcode = '22023';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'created_at', a.created_at,
      'expires_at', a.expires_at, 'author', coalesce(ad.display_name, 'Administratör'),
      'active', a.expires_at is null or a.expires_at > now()) order by a.created_at desc)
    from (select * from clinical_private.staff_announcements where organization_id = org and archived_at is null
          order by created_at desc limit 50) a
    left join clinical_private.administrators ad on ad.user_id = a.created_by and ad.organization_id = org), '[]'::jsonb);
end $$;
revoke all on function clinical_private.announcements_admin(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function clinical_private.announcements_admin(uuid, text, jsonb) to authenticated;
create function public.clinician_announcements(p_organization_id uuid, p_action text default 'list', p_args jsonb default '{}') returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.announcements_admin(p_organization_id, p_action, p_args)$$;
revoke all on function public.clinician_announcements(uuid, text, jsonb) from public, anon;
grant execute on function public.clinician_announcements(uuid, text, jsonb) to authenticated;

-- Consultations: a doctor asks a colleague about a patient, optionally about one record.
create table clinical_private.consultations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_private.organizations,
  patient_id uuid not null references clinical_private.patients,
  record_id uuid references clinical_private.records,
  from_user uuid not null references auth.users(id),
  to_user uuid not null references auth.users(id),
  message text not null check (length(btrim(message)) between 1 and 2000),
  reply text check (reply is null or length(btrim(reply)) between 1 and 2000),
  status text not null default 'open' check (status in ('open', 'answered', 'closed')),
  created_at timestamptz not null default now(),
  replied_at timestamptz, closed_at timestamptz, closed_by uuid references auth.users(id),
  check (from_user <> to_user),
  check ((status = 'open' and reply is null) or status <> 'open'),
  check ((status = 'closed') = (closed_at is not null))
);
create index consultations_to on clinical_private.consultations(to_user, created_at desc);
create index consultations_from on clinical_private.consultations(from_user, created_at desc);
alter table clinical_private.consultations enable row level security;
revoke all on clinical_private.consultations from public, anon, authenticated;

create function clinical_private.consultation(p_action text, args jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor(); n integer; org uuid; pid uuid; rec uuid; target uuid; item clinical_private.consultations;
begin
  if not clinical_private.portal_assurance_sufficient()
    or not exists (select 1 from clinical_private.staff where user_id = actor and active)
  then raise exception 'Staff authentication required' using errcode = '42501'; end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  if p_action = 'colleagues' then
    return coalesce((select jsonb_agg(jsonb_build_object('user_id', c.user_id, 'display_name', c.display_name) order by c.display_name)
      from (select distinct s.user_id, s.display_name from clinical_private.staff s
            join clinical_private.staff me on me.organization_id = s.organization_id and me.user_id = actor and me.active
            where s.active and s.role = 'doctor' and s.user_id <> actor) c), '[]'::jsonb);
  elsif p_action = 'send' then
    pid := (args->>'patient')::uuid; target := (args->>'to')::uuid; rec := nullif(args->>'record', '')::uuid;
    org := clinical_private.care_organization(actor, pid);
    if org is null then raise exception 'Active care relation required' using errcode = '42501'; end if;
    if target is null or target = actor or not exists (select 1 from clinical_private.staff s
      where s.user_id = target and s.organization_id = org and s.active and s.role = 'doctor')
    then raise exception 'Colleague unavailable' using errcode = '22023'; end if;
    if length(btrim(coalesce(args->>'message', ''))) not between 1 and 2000 then raise exception 'Message required' using errcode = '22023'; end if;
    if rec is not null and not exists (select 1 from clinical_private.records r
      where r.id = rec and r.patient_id = pid and r.organization_id = org and r.annulled_at is null)
    then raise exception 'Record unavailable' using errcode = '22023'; end if;
    insert into clinical_private.consultations (organization_id, patient_id, record_id, from_user, to_user, message)
    values (org, pid, rec, actor, target, btrim(args->>'message')) returning * into item;
    insert into clinical_private.audit (actor_id, patient_id, action, record_id) values (actor, pid, 'consultation.send', rec);
  elsif p_action = 'reply' then
    if length(btrim(coalesce(args->>'reply', ''))) not between 1 and 2000 then raise exception 'Reply required' using errcode = '22023'; end if;
    update clinical_private.consultations set reply = btrim(args->>'reply'), status = 'answered', replied_at = now()
    where id = (args->>'id')::uuid and to_user = actor and status = 'open' returning * into item;
    if item.id is null then raise exception 'Consultation unavailable' using errcode = '40001'; end if;
    insert into clinical_private.audit (actor_id, patient_id, action, record_id) values (actor, item.patient_id, 'consultation.reply', item.record_id);
  elsif p_action = 'close' then
    update clinical_private.consultations set status = 'closed', closed_at = now(), closed_by = actor
    where id = (args->>'id')::uuid and actor in (from_user, to_user) and status <> 'closed' returning * into item;
    if item.id is null then raise exception 'Consultation unavailable' using errcode = '40001'; end if;
    insert into clinical_private.audit (actor_id, patient_id, action, record_id) values (actor, item.patient_id, 'consultation.close', item.record_id);
  else raise exception 'Invalid action' using errcode = '22023';
  end if;
  return jsonb_build_object('ok', true, 'id', item.id);
end $$;
revoke all on function clinical_private.consultation(text, jsonb) from public, anon, authenticated;
grant execute on function clinical_private.consultation(text, jsonb) to authenticated;
create function public.clinician_consultation(p_action text, p_args jsonb default '{}') returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.consultation(p_action, p_args)$$;
revoke all on function public.clinician_consultation(text, jsonb) from public, anon;
grant execute on function public.clinician_consultation(text, jsonb) to authenticated;

-- Deviations in the doctor's own patient pool (assigned patients). Each patient is compared with their own
-- baseline: the last 7 days against the 60 days before. Rules are fixed and shown with their numbers.
create function clinical_private.patient_deviations(p_actor uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog as $$
with pool as (
  select distinct p.id, p.display_name, p.last_sync_at
  from clinical_private.assignments a
  join clinical_private.staff s on s.user_id = a.clinician_id and s.organization_id = a.organization_id and s.active
  join clinical_private.patients p on p.id = a.patient_id
  where a.clinician_id = p_actor and a.active
), today as (select (now() at time zone 'Europe/Stockholm')::date as d),
win as (
  select h.*, case when h.day > t.d - 7 then 'recent' else 'base' end as w
  from clinical_private.health_daily h join pool on pool.id = h.patient_id cross join today t
  where h.day > t.d - 67 and h.day <= t.d and h.kind in ('resting-heart-rate', 'hrv', 'sleep', 'oxygen', 'raw.steps', 'steps')
), stats as (
  select patient_id, kind,
    count(*) filter (where w = 'recent' and n > 0) as rn, count(*) filter (where w = 'base' and n > 0) as bn,
    sum(total) filter (where w = 'recent') / nullif(sum(n) filter (where w = 'recent'), 0) as rmean,
    sum(total) filter (where w = 'base') / nullif(sum(n) filter (where w = 'base'), 0) as bmean,
    avg(total) filter (where w = 'recent' and n > 0) as rday, avg(total) filter (where w = 'base' and n > 0) as bday,
    min(lo) filter (where w = 'recent') as rmin,
    count(*) filter (where w = 'recent' and seconds is not null) as rnights, count(*) filter (where w = 'base' and seconds is not null) as bnights,
    avg(seconds) filter (where w = 'recent') as rsleep, avg(seconds) filter (where w = 'base') as bsleep,
    max(day) filter (where w = 'recent') as last_day
  from win group by patient_id, kind
), labs as (
  select distinct on (r.patient_id, o->>'code') r.patient_id, o, (r.payload->>'sampledAt')::timestamptz as sampled
  from clinical_private.records r join pool on pool.id = r.patient_id
  cross join lateral jsonb_array_elements(r.payload->'observations') o
  where r.kind = 'lab' and r.status = 'published' and r.superseded_at is null and r.annulled_at is null
    and r.published_at > now() - interval '90 days'
  order by r.patient_id, o->>'code', (r.payload->>'sampledAt')::timestamptz desc
), found as (
  select patient_id, 'resting-heart-rate' as rule, 'warn' as severity, 'Stigande vilopuls' as title,
    round(rmean)::text || ' slag/min senaste 7 dagarna mot ' || round(bmean)::text || ' slag/min tidigare' as detail, last_day as at
  from stats where kind = 'resting-heart-rate' and rn >= 3 and bn >= 14 and rmean - bmean >= 5 and rmean >= bmean * 1.1
  union all
  select patient_id, 'hrv', 'warn', 'Sjunkande HRV',
    round(rmean)::text || ' ms senaste 7 dagarna mot ' || round(bmean)::text || ' ms tidigare', last_day
  from stats where kind = 'hrv' and rn >= 3 and bn >= 14 and rmean <= bmean * 0.8
  union all
  select patient_id, 'sleep', 'info', 'Kortare sömn',
    replace(round((rsleep / 3600)::numeric, 1)::text, '.', ',') || ' tim per natt senaste veckan mot '
      || replace(round((bsleep / 3600)::numeric, 1)::text, '.', ',') || ' tim tidigare', last_day
  from stats where kind = 'sleep' and rnights >= 3 and bnights >= 14 and rsleep <= bsleep - 3600 and rsleep < 6.5 * 3600
  union all
  select patient_id, 'oxygen', case when rmin < 90 then 'high' else 'warn' end, 'Låg syremättnad',
    'Lägsta ' || round(rmin)::text || ' % senaste 7 dagarna', last_day
  from stats where kind = 'oxygen' and rmin < 92
  union all
  select s.patient_id, 'steps', 'info', 'Minskad aktivitet',
    round(s.rday)::text || ' steg per dag senaste veckan mot ' || round(s.bday)::text || ' tidigare', s.last_day
  from stats s
  where s.kind = case when exists (select 1 from stats x where x.patient_id = s.patient_id and x.kind = 'raw.steps') then 'raw.steps' else 'steps' end
    and s.rn >= 4 and s.bn >= 14 and s.rday <= s.bday * 0.6
  union all
  select id, 'sync', 'info', 'Ingen datasynk',
    'Senaste synk för ' || ((now() at time zone 'Europe/Stockholm')::date - (last_sync_at at time zone 'Europe/Stockholm')::date)::text || ' dagar sedan',
    (last_sync_at at time zone 'Europe/Stockholm')::date
  from pool where last_sync_at is not null and last_sync_at < now() - interval '14 days'
  union all
  select patient_id, 'lab', 'warn', 'Provsvar utanför referens',
    (o->>'name') || ' ' || (o->>'value') || coalesce(' ' || nullif(o->>'unit', ''), ''), (sampled at time zone 'Europe/Stockholm')::date
  from labs
  where o->>'comparator' = '=' and o->>'value' ~ '^-?[0-9]+([.,][0-9]+)?$'
    and ((jsonb_typeof(o->'referenceLow') = 'number' and replace(o->>'value', ',', '.')::numeric < (o->>'referenceLow')::numeric)
      or (jsonb_typeof(o->'referenceHigh') = 'number' and replace(o->>'value', ',', '.')::numeric > (o->>'referenceHigh')::numeric))
)
select coalesce(jsonb_agg(jsonb_build_object('patient_id', f.patient_id, 'display_name', pool.display_name, 'rule', f.rule,
    'severity', f.severity, 'title', f.title, 'detail', f.detail, 'at', f.at)
  order by case f.severity when 'high' then 0 when 'warn' then 1 else 2 end, f.at desc nulls last, pool.display_name), '[]'::jsonb)
from found f join pool on pool.id = f.patient_id
$$;
revoke all on function clinical_private.patient_deviations(uuid) from public, anon, authenticated;

-- Start page for the clinician: everything the doctor should see first, in one read.
create function clinical_private.clinician_overview() returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor(); n integer; result jsonb;
begin
  if not clinical_private.portal_assurance_sufficient()
    or not exists (select 1 from clinical_private.staff where user_id = actor and active)
  then raise exception 'Staff authentication required' using errcode = '42501'; end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  with orgs as (select organization_id from clinical_private.staff where user_id = actor and active),
  drafts as (
    select r.id, r.patient_id, p.display_name, r.kind, r.payload->>'title' as title, r.created_at
    from clinical_private.records r
    join clinical_private.patients p on p.id = r.patient_id
    join orgs on orgs.organization_id = r.organization_id
    where r.status = 'draft' and r.superseded_at is null
      and (r.created_by = actor or exists (select 1 from clinical_private.assignments a
        where a.patient_id = r.patient_id and a.organization_id = r.organization_id and a.clinician_id = actor and a.active))
  )
  select jsonb_build_object(
    'counts', jsonb_build_object(
      'assigned', (select count(distinct a.patient_id) from clinical_private.assignments a
        join orgs on orgs.organization_id = a.organization_id
        join clinical_private.organization_patients op on op.patient_id = a.patient_id and op.organization_id = a.organization_id and op.active
        where a.clinician_id = actor and a.active),
      'clinic', (select count(distinct op.patient_id) from clinical_private.organization_patients op
        join orgs on orgs.organization_id = op.organization_id where op.active),
      'unsigned', (select count(*) from drafts),
      'consultations', (select count(*) from clinical_private.consultations c where c.to_user = actor and c.status = 'open')),
    'unsigned', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at desc) from (select * from drafts order by created_at desc limit 5) d), '[]'::jsonb),
    'announcements', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'created_at', a.created_at,
        'author', coalesce(ad.display_name, 'Administratör')) order by a.created_at desc)
      from (select sa.* from clinical_private.staff_announcements sa join orgs on orgs.organization_id = sa.organization_id
            where sa.archived_at is null and (sa.expires_at is null or sa.expires_at > now()) order by sa.created_at desc limit 10) a
      left join clinical_private.administrators ad on ad.user_id = a.created_by and ad.organization_id = a.organization_id), '[]'::jsonb),
    'consultations', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'patient_id', c.patient_id, 'display_name', p.display_name,
        'direction', case when c.to_user = actor then 'in' else 'out' end, 'status', c.status, 'message', c.message, 'reply', c.reply,
        'created_at', c.created_at, 'replied_at', c.replied_at,
        'from_name', (select s.display_name from clinical_private.staff s where s.user_id = c.from_user and s.organization_id = c.organization_id),
        'to_name', (select s.display_name from clinical_private.staff s where s.user_id = c.to_user and s.organization_id = c.organization_id),
        'record', (select jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.payload->>'title') from clinical_private.records r where r.id = c.record_id))
        order by (c.status = 'open' and c.to_user = actor) desc, coalesce(c.replied_at, c.created_at) desc)
      from (select * from clinical_private.consultations where (to_user = actor or from_user = actor) and status <> 'closed'
            order by created_at desc limit 30) c
      join clinical_private.patients p on p.id = c.patient_id), '[]'::jsonb),
    'deviations', clinical_private.patient_deviations(actor)
  ) into result;
  insert into clinical_private.audit (actor_id, action) values (actor, 'clinician.overview');
  return result;
end $$;
revoke all on function clinical_private.clinician_overview() from public, anon, authenticated;
grant execute on function clinical_private.clinician_overview() to authenticated;
create function public.clinician_overview() returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.clinician_overview()$$;
revoke all on function public.clinician_overview() from public, anon;
grant execute on function public.clinician_overview() to authenticated;
