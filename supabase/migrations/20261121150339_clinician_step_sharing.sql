alter table clinical_private.vitals
  add column calendar_day date,
  drop constraint vitals_kind_check,
  drop constraint vitals_check1,
  drop constraint vitals_definition_check,
  add constraint vitals_kind_check check(kind in ('heart-rate','resting-heart-rate','sleep','steps')),
  add constraint vitals_check1 check(
    (kind in ('heart-rate','resting-heart-rate') and value>0 and value<1000 and unit='beats/min')
    or (kind='sleep' and value is null and unit='interval')
    or (kind='steps' and value>=0 and value<1000000 and value=trunc(value) and unit='count'
      and end_at>start_at and end_at<=start_at+interval '26 hours')
  ),
  add constraint vitals_definition_check check(
    definition=case kind when 'sleep' then 'asleep' when 'steps' then 'steps-daily' else kind end
  ),
  add constraint vitals_calendar_day check(
    (kind<>'steps' and calendar_day is null) or
    (kind='steps' and calendar_day is not null and abs(calendar_day-(start_at at time zone 'UTC')::date)<=1)
  );

create index vitals_patient_kind_history on clinical_private.vitals(patient_id,kind,end_at desc,id desc)
  where deleted_at is null;

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
 select a.organization_id into org from clinical_private.assignments a join clinical_private.staff s on s.user_id=a.clinician_id and s.organization_id=a.organization_id
 where a.patient_id=pid and a.clinician_id=actor and a.active and s.active order by a.organization_id limit 1;
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

create function public.clinician_vital_history(p_patient uuid,p_kind text,p_before_at timestamptz,p_before_id uuid)
returns jsonb language sql security invoker set search_path=pg_catalog as $$
  select clinical_private.gateway('vital_history',jsonb_build_object(
    'patient',p_patient,'kind',p_kind,'before_at',p_before_at,'before_id',p_before_id
  ))
$$;

revoke all on function public.clinician_vital_history(uuid,text,timestamptz,uuid) from public,anon;
grant execute on function public.clinician_vital_history(uuid,text,timestamptz,uuid) to authenticated;
