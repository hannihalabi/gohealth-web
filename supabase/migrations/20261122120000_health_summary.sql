-- Vitalparametrar must answer within the 8 s statement timeout even with years of history.
-- 1) Legacy vitals that a newer measurement replaces are flagged once, instead of probed on every read.
alter table clinical_private.vitals add column superseded boolean not null default false;
update clinical_private.vitals v set superseded = true
where exists (select 1 from clinical_private.health_measurements m where m.patient_id = v.patient_id and m.source_id = v.source_id);
create index vitals_live on clinical_private.vitals(patient_id, kind, end_at desc) where deleted_at is null and not superseded;

create function clinical_private.flag_superseded_vitals() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  update clinical_private.vitals v set superseded = true
  from new_rows n where v.patient_id = n.patient_id and v.source_id = n.source_id and not v.superseded;
  return null;
end $$;
create function clinical_private.flag_new_vital() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  new.superseded := exists (select 1 from clinical_private.health_measurements m where m.patient_id = new.patient_id and m.source_id = new.source_id);
  return new;
end $$;
create trigger flag_superseded_vitals after insert on clinical_private.health_measurements
  referencing new table as new_rows for each statement execute function clinical_private.flag_superseded_vitals();
create trigger flag_new_vital before insert on clinical_private.vitals
  for each row execute function clinical_private.flag_new_vital();

create or replace view clinical_private.all_health_measurements with (security_invoker=true) as
 select v.id,v.patient_id,v.source_id,v.kind,v.value,v.unit,v.start_at,v.end_at,v.source,v.definition,v.metadata,v.received_at
 from clinical_private.health_measurements v where v.deleted_at is null
 union all
 select v.id,v.patient_id,v.source_id,v.kind,v.value,v.unit,v.start_at,v.end_at,v.source,v.definition,v.metadata,v.received_at
 from clinical_private.vitals v where v.deleted_at is null and not v.superseded
 and not exists(select 1 from clinical_private.health_sample_deletions d where d.patient_id=v.patient_id and d.source_id=v.source_id);

-- 2) Count and time span per patient and metric, kept exact by triggers on every insert, update and delete.
create table clinical_private.health_kind_summary (
  patient_id uuid not null references clinical_private.patients on delete cascade,
  kind text not null,
  n bigint not null,
  first_at timestamptz,
  last_at timestamptz,
  primary key (patient_id, kind)
);
alter table clinical_private.health_kind_summary enable row level security;
revoke all on clinical_private.health_kind_summary from public, anon, authenticated;
create index health_measurements_first on clinical_private.health_measurements(patient_id, kind, start_at) where deleted_at is null;
-- Trend reads only the requested window, without touching the wide metadata column.
create index health_measurements_window on clinical_private.health_measurements(patient_id, end_at) include (kind, value, start_at) where deleted_at is null;

create function clinical_private.health_summary_bounds(keys jsonb) returns void
language sql security definer set search_path = pg_catalog as $$
  update clinical_private.health_kind_summary s set
    first_at = (select m.start_at from clinical_private.health_measurements m
      where m.patient_id = s.patient_id and m.kind = s.kind and m.deleted_at is null order by m.start_at limit 1),
    last_at = (select m.end_at from clinical_private.health_measurements m
      where m.patient_id = s.patient_id and m.kind = s.kind and m.deleted_at is null order by m.end_at desc limit 1)
  where (s.patient_id, s.kind) in (select (k->>0)::uuid, k->>1 from jsonb_array_elements(keys) k);
  delete from clinical_private.health_kind_summary s
  where s.n <= 0 and (s.patient_id, s.kind) in (select (k->>0)::uuid, k->>1 from jsonb_array_elements(keys) k);
$$;
create function clinical_private.health_summary_insert() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
begin
  insert into clinical_private.health_kind_summary as s (patient_id, kind, n, first_at, last_at)
  select patient_id, kind, count(*), min(start_at), max(end_at) from new_rows where deleted_at is null group by patient_id, kind
  on conflict (patient_id, kind) do update set n = s.n + excluded.n,
    first_at = least(s.first_at, excluded.first_at), last_at = greatest(s.last_at, excluded.last_at);
  return null;
end $$;
create function clinical_private.health_summary_update() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
declare keys jsonb;
begin
  with delta as (
    select patient_id, kind, sum(d) d from (
      select patient_id, kind, -1 d from old_rows where deleted_at is null
      union all select patient_id, kind, 1 from new_rows where deleted_at is null) x
    group by patient_id, kind having sum(d) <> 0)
  insert into clinical_private.health_kind_summary as s (patient_id, kind, n)
  select patient_id, kind, d from delta
  on conflict (patient_id, kind) do update set n = s.n + excluded.n;
  select coalesce(jsonb_agg(distinct jsonb_build_array(patient_id, kind)), '[]') into keys
  from (select patient_id, kind from old_rows union select patient_id, kind from new_rows) k;
  perform clinical_private.health_summary_bounds(keys);
  return null;
end $$;
create function clinical_private.health_summary_delete() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
declare keys jsonb;
begin
  -- Only existing rows are adjusted: when a patient is removed, the summary is already gone with it.
  update clinical_private.health_kind_summary s set n = s.n - d.n
  from (select patient_id, kind, count(*) n from old_rows where deleted_at is null group by patient_id, kind) d
  where s.patient_id = d.patient_id and s.kind = d.kind;
  select coalesce(jsonb_agg(distinct jsonb_build_array(patient_id, kind)), '[]') into keys from old_rows;
  perform clinical_private.health_summary_bounds(keys);
  return null;
end $$;
revoke all on function clinical_private.flag_superseded_vitals(), clinical_private.flag_new_vital(),
  clinical_private.health_summary_bounds(jsonb), clinical_private.health_summary_insert(),
  clinical_private.health_summary_update(), clinical_private.health_summary_delete() from public, anon, authenticated;
-- Triggers first, then the backfill: the trigger lock holds off concurrent syncs until this commits.
create trigger health_summary_insert after insert on clinical_private.health_measurements
  referencing new table as new_rows for each statement execute function clinical_private.health_summary_insert();
create trigger health_summary_update after update on clinical_private.health_measurements
  referencing old table as old_rows new table as new_rows for each statement execute function clinical_private.health_summary_update();
create trigger health_summary_delete after delete on clinical_private.health_measurements
  referencing old table as old_rows for each statement execute function clinical_private.health_summary_delete();
insert into clinical_private.health_kind_summary (patient_id, kind, n, first_at, last_at)
select patient_id, kind, count(*), min(start_at), max(end_at) from clinical_private.health_measurements
where deleted_at is null group by patient_id, kind;

-- 3) The overview reads the summary plus the few remaining legacy vitals.
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
   (select to_jsonb(v)-'patient_id' from clinical_private.all_health_measurements v where v.patient_id=pid and v.kind=g.kind order by v.end_at desc,v.id desc limit 1)) order by g.kind),'[]') into metrics
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
