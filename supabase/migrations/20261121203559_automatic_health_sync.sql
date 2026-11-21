-- Generic transport for every app metric. Existing v1/v2 contracts stay intact.
create table clinical_private.health_measurements (
 id uuid primary key default gen_random_uuid(),
 patient_id uuid not null references clinical_private.patients,
 source_id uuid not null,
 kind text not null check(length(kind) between 1 and 200),
 value double precision check(value not in ('NaN'::double precision,'Infinity'::double precision,'-Infinity'::double precision)),
 unit text not null check(length(unit) between 1 and 80),
 start_at timestamptz not null, end_at timestamptz not null check(end_at>=start_at),
 source text not null check(length(source) between 1 and 500),
 definition text not null check(length(definition) between 1 and 200),
 metadata jsonb not null check(jsonb_typeof(metadata)='object' and octet_length(metadata::text)<=16384),
 deleted_at timestamptz, received_at timestamptz not null default now(),
 unique(patient_id,source_id),
 check(value is not null or unit='interval')
);
create index health_measurements_history on clinical_private.health_measurements(patient_id,kind,end_at desc,id desc) where deleted_at is null;
create table clinical_private.health_sample_deletions (
 patient_id uuid not null references clinical_private.patients, source_id uuid not null,
 deleted_at timestamptz not null default now(), primary key(patient_id,source_id)
);
create table clinical_private.app_health_values (
 event_id uuid not null, patient_id uuid not null references clinical_private.patients,
 key text not null check(length(key) between 1 and 200),
 display_kind text not null check(display_kind in ('current','history')),
 title text not null check(length(title) between 1 and 300),
 section text not null check(length(section)<=300),
 value text not null check(length(value)<=3000), unit text not null check(length(unit)<=80),
 source text not null check(length(source)<=3000),
 record_id text check(length(record_id)<=500), measured_at timestamptz, observed_at timestamptz not null,
 received_order bigint generated always as identity, received_at timestamptz not null default now(),
 primary key(patient_id,event_id)
);
create index app_health_values_history on clinical_private.app_health_values(patient_id,key,observed_at desc,event_id desc);
create index app_health_values_current on clinical_private.app_health_values(patient_id,key,received_order desc) where display_kind='current';
create table clinical_private.health_sync_status (
 patient_id uuid primary key references clinical_private.patients,
 state text not null check(state in ('syncing','complete','retrying')),
 updated_at timestamptz not null default now()
);
alter table clinical_private.health_measurements enable row level security;
alter table clinical_private.health_sample_deletions enable row level security;
alter table clinical_private.app_health_values enable row level security;
alter table clinical_private.health_sync_status enable row level security;
revoke all on clinical_private.health_measurements,clinical_private.health_sample_deletions,clinical_private.app_health_values,clinical_private.health_sync_status from public,anon,authenticated;

create view clinical_private.all_health_measurements with (security_invoker=true) as
 select v.id,v.patient_id,v.source_id,v.kind,v.value,v.unit,v.start_at,v.end_at,v.source,v.definition,v.metadata,v.received_at
 from clinical_private.health_measurements v where v.deleted_at is null
 union all
 select v.id,v.patient_id,v.source_id,v.kind,v.value,v.unit,v.start_at,v.end_at,v.source,v.definition,v.metadata,v.received_at
 from clinical_private.vitals v where v.deleted_at is null
 and not exists(select 1 from clinical_private.health_measurements newer where newer.patient_id=v.patient_id and newer.source_id=v.source_id)
 and not exists(select 1 from clinical_private.health_sample_deletions d where d.patient_id=v.patient_id and d.source_id=v.source_id);
revoke all on clinical_private.all_health_measurements from public,anon,authenticated;

create function clinical_private.automatic_health(action text,args jsonb) returns jsonb
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
   (select to_jsonb(v)-'patient_id' from clinical_private.all_health_measurements v where v.patient_id=pid and v.kind=g.kind order by v.end_at desc,v.id desc limit 1)) order by g.kind),'[]') into metrics
  from (select kind,count(*) n,min(start_at) first_at,max(end_at) last_at from clinical_private.all_health_measurements where patient_id=pid group by kind) g;
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
   select * from clinical_private.all_health_measurements where patient_id=pid and kind=metric and (cursor_at is null or (end_at,id)<(cursor_at,cursor_id)) order by end_at desc,id desc limit 201
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
revoke all on function clinical_private.automatic_health(text,jsonb) from public,anon;
grant execute on function clinical_private.automatic_health(text,jsonb) to authenticated;
create function public.gohealth_sync_health_v3(p_samples jsonb,p_deleted jsonb,p_display jsonb default '[]',p_state text default 'syncing') returns jsonb
 language sql security invoker set search_path=pg_catalog as $$select clinical_private.automatic_health('ingest',jsonb_build_object('samples',p_samples,'deleted',p_deleted,'display',p_display,'state',p_state))$$;
create function public.clinician_health_v3(p_patient uuid,p_kind text default null,p_cursor jsonb default null,p_mode text default 'overview') returns jsonb
 language sql security invoker set search_path=pg_catalog as $$select clinical_private.automatic_health('read',jsonb_build_object('patient',p_patient,'kind',p_kind,'cursor',p_cursor,'mode',p_mode))$$;
revoke all on function public.gohealth_sync_health_v3(jsonb,jsonb,jsonb,text),public.clinician_health_v3(uuid,text,jsonb,text) from public,anon;
grant execute on function public.gohealth_sync_health_v3(jsonb,jsonb,jsonb,text),public.clinician_health_v3(uuid,text,jsonb,text) to authenticated;
