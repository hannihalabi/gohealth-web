-- Full history is opt-in. Existing client contracts remain available.
alter table clinical_private.vitals
 add column metadata jsonb not null default '{}',
 drop constraint vitals_kind_check, drop constraint vitals_check1,
 drop constraint vitals_definition_check, drop constraint pulse_value_required;
alter table clinical_private.vitals add constraint vitals_metadata
 check(jsonb_typeof(metadata)='object' and octet_length(metadata::text)<=8192);
alter table clinical_private.vitals add constraint vitals_v2_contract check(
 (case kind
 when 'heart-rate' then value>0 and value<1000 and unit='beats/min' and definition=kind
 when 'resting-heart-rate' then value>0 and value<1000 and unit='beats/min' and definition=kind
 when 'sleep' then value is null and unit='interval' and definition in ('asleep','asleep-core','asleep-deep','asleep-rem','asleep-unspecified')
 when 'sleep-awake' then value is null and unit='interval' and definition='awake'
 when 'sleep-in-bed' then value is null and unit='interval' and definition='in-bed'
 when 'steps' then value>=0 and value<1000000 and value=trunc(value) and unit='count' and definition='steps-daily' and end_at>start_at and end_at<=start_at+interval '26 hours'
 when 'step-count' then value>=0 and value<1000000 and value=trunc(value) and unit='count' and definition=kind
 when 'hrv' then value>0 and value<10000 and unit='ms' and definition=kind
 when 'hrv-rmssd' then value>0 and value<10000 and unit='ms' and definition=kind
 when 'respiratory-rate' then value>0 and value<300 and unit='breaths/min' and definition=kind
 when 'oxygen' then value>=0 and value<=100 and unit='%' and definition=kind
 when 'vo2-max' then value>0 and value<300 and unit='ml/kg/min' and definition=kind
 when 'weight' then value>0 and value<1000 and unit='kg' and definition=kind
 when 'temperature' then value>-100 and value<100 and unit='degC' and definition=kind
 when 'fev1' then value>0 and value<100 and unit='L' and definition=kind
 when 'fvc' then value>0 and value<100 and unit='L' and definition=kind
 when 'pef' then value>0 and value<5000 and unit='L/min' and definition=kind
 when 'distance' then value>=0 and value<100000 and unit='km' and definition=kind
 when 'active-energy' then value>=0 and value<10000000 and unit='kcal' and definition=kind
 when 'flights' then value>=0 and value<1000000 and value=trunc(value) and unit='count' and definition=kind
 when 'workout' then value>=0 and value<100000 and unit='min' and definition=kind
 else false end) is true
 and (kind in ('sleep','sleep-awake','sleep-in-bed') or value is not null)
);

create function clinical_private.health_history(action text,args jsonb) returns jsonb
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
 if not clinical_private.portal_assurance_sufficient() or not exists(
   select 1 from clinical_private.assignments a join clinical_private.staff s on s.user_id=a.clinician_id and s.organization_id=a.organization_id
   where a.patient_id=pid and a.clinician_id=actor and a.active and s.active
 ) then raise exception 'Active clinical care relation required' using errcode='42501';end if;
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
revoke all on function clinical_private.health_history(text,jsonb) from public,anon,authenticated;
create function public.gohealth_ingest_vitals_v2(p_samples jsonb,p_deleted jsonb) returns jsonb
language sql security invoker set search_path=pg_catalog as $$select clinical_private.health_history('ingest',jsonb_build_object('samples',p_samples,'deleted',p_deleted))$$;
create function public.clinician_vitals_v2(p_patient uuid,p_kind text default null,p_cursor jsonb default null) returns jsonb
language sql security invoker set search_path=pg_catalog as $$select clinical_private.health_history(case when p_kind is null then 'overview' else 'page' end,jsonb_build_object('patient',p_patient,'kind',p_kind,'cursor',p_cursor))$$;
revoke all on function public.gohealth_ingest_vitals_v2(jsonb,jsonb),public.clinician_vitals_v2(uuid,text,jsonb) from public,anon;
grant execute on function public.gohealth_ingest_vitals_v2(jsonb,jsonb),public.clinician_vitals_v2(uuid,text,jsonb) to authenticated;
-- Invoker wrappers need execute on the private gateway; no table permissions are granted.
grant execute on function clinical_private.health_history(text,jsonb) to authenticated;
