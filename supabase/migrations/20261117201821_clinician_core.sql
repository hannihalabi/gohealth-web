-- Clinical source of truth. Private tables are accessible only through audited RPCs.
-- Filename version matches the applied GoHealth Dev migration history.
-- No existing imaging/care tables are modified. Provisioning is an operator task.
create schema clinical_private;
revoke all on schema clinical_private from public, anon, authenticated;
grant usage on schema clinical_private to authenticated;

create table clinical_private.organizations (
 id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 160)
);
create table clinical_private.staff (
 user_id uuid not null references auth.users(id), organization_id uuid not null references clinical_private.organizations,
 display_name text not null check(length(display_name) between 1 and 120),
 role text not null check(role in ('doctor','nurse')), active boolean not null default true,
 primary key(user_id,organization_id)
);
create table clinical_private.patients (
 id uuid primary key default gen_random_uuid(), account_id uuid unique references auth.users(id),
 display_name text not null check(length(display_name) between 1 and 160),
 identity_label text not null unique check(length(identity_label) between 3 and 40),
 identity_verified boolean not null default false, last_sync_at timestamptz,
 created_at timestamptz not null default now()
);
create table clinical_private.assignments (
 patient_id uuid not null references clinical_private.patients, organization_id uuid not null references clinical_private.organizations,
 clinician_id uuid not null, active boolean not null default true,
 primary key(patient_id,organization_id,clinician_id),
 foreign key(clinician_id,organization_id) references clinical_private.staff(user_id,organization_id)
);
create index assignments_staff on clinical_private.assignments(clinician_id,active,patient_id);
create table clinical_private.records (
 id uuid primary key default gen_random_uuid(), patient_id uuid not null references clinical_private.patients,
 organization_id uuid not null references clinical_private.organizations,
 kind text not null check(kind in ('lab','vaccination','imaging')),
 status text not null default 'draft' check(status in ('draft','published')),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<100000),
 revision integer not null default 1 check(revision>0), version integer not null default 1 check(version>0),
 replaces_id uuid references clinical_private.records, correction_reason text,
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 published_by uuid references auth.users(id), published_at timestamptz, superseded_at timestamptz,
 check((status='draft' and published_at is null and published_by is null) or (status='published' and published_at is not null and published_by is not null)),
 check((replaces_id is null and version=1) or (replaces_id is not null and length(btrim(correction_reason)) between 1 and 500))
);
create unique index one_published_replacement on clinical_private.records(replaces_id) where status='published';
create index records_patient on clinical_private.records(patient_id,created_at desc,id);
create table clinical_private.audit (
 id bigint generated always as identity primary key, actor_id uuid not null,
 patient_id uuid references clinical_private.patients, action text not null,
 record_id uuid, created_at timestamptz not null default now()
);
create index audit_patient on clinical_private.audit(patient_id,created_at desc);
create table clinical_private.request_limits (
 actor_id uuid not null, bucket timestamptz not null, requests integer not null,
 primary key(actor_id,bucket)
);
create table clinical_private.vitals (
 id uuid primary key default gen_random_uuid(), patient_id uuid not null references clinical_private.patients,
 source_id uuid not null, kind text not null check(kind in ('heart-rate','resting-heart-rate','sleep')),
 value double precision, unit text not null, start_at timestamptz not null,end_at timestamptz not null,
 source text not null,definition text not null,deleted_at timestamptz,
 received_at timestamptz not null default now(), unique(patient_id,source_id),
 check(end_at>=start_at), check(length(source) between 1 and 300),
 check((kind in ('heart-rate','resting-heart-rate') and value>0 and value<1000 and unit='beats/min') or (kind='sleep' and value is null and unit='interval')),
 check(definition in ('heart-rate','resting-heart-rate','asleep'))
);
create index vitals_patient on clinical_private.vitals(patient_id,end_at desc) where deleted_at is null;

alter table clinical_private.organizations enable row level security;
alter table clinical_private.staff enable row level security;
alter table clinical_private.patients enable row level security;
alter table clinical_private.assignments enable row level security;
alter table clinical_private.records enable row level security;
alter table clinical_private.audit enable row level security;
alter table clinical_private.vitals enable row level security;
alter table clinical_private.request_limits enable row level security;
revoke all on all tables in schema clinical_private from public, anon, authenticated;
revoke all on all sequences in schema clinical_private from public, anon, authenticated;

create function clinical_private.validate_payload(k text,p jsonb) returns void
language plpgsql set search_path=pg_catalog as $$
declare o jsonb; codes text[]:='{}'; key text;
begin
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>100000 then raise exception 'Invalid payload' using errcode='22023';end if;
 foreach key in array array['title','source','sampledAt','comment'] loop
   if jsonb_typeof(p->key) is distinct from 'string' then raise exception 'Missing field' using errcode='22023';end if;
 end loop;
 if length(btrim(p->>'title')) not between 1 and 160 or length(btrim(p->>'source')) not between 1 and 160 or length(p->>'comment')>4000
 or (p->>'sampledAt')::timestamptz > now()+interval '1 day' then raise exception 'Invalid metadata' using errcode='22023';end if;
 if k='lab' then
   if jsonb_typeof(p->'observations') is distinct from 'array' or jsonb_array_length(p->'observations') not between 1 and 100 then raise exception 'Observations required' using errcode='22023';end if;
   for o in select value from jsonb_array_elements(p->'observations') loop
     if (o->>'code') is null or (o->>'code') not in ('tsh','free-t4','alt','ast','creatinine','egfr','apob','ldl','total-cholesterol','hba1c','hemoglobin') or (o->>'code')=any(codes)
     or jsonb_typeof(o->'name') is distinct from 'string' or length(btrim(o->>'name')) not between 1 and 120
     or jsonb_typeof(o->'value') is distinct from 'string' or length(btrim(o->>'value')) not between 1 and 120
     or jsonb_typeof(o->'unit') is distinct from 'string' or length(o->>'unit')>80
     or jsonb_typeof(o->'referenceText') is distinct from 'string' or length(o->>'referenceText')>300
     or coalesce(o->>'comparator','') not in ('=','<','>','<=','>=','text') then raise exception 'Invalid observation' using errcode='22023';end if;
     if o->>'comparator'<>'text' and ((o->>'value') !~ '^-?[0-9]+(\.[0-9]+)?$' or btrim(o->>'unit')='') then raise exception 'Invalid numeric result' using errcode='22023';end if;
     if jsonb_typeof(o->'referenceLow') not in ('number','null') or not o ? 'referenceLow' or jsonb_typeof(o->'referenceHigh') not in ('number','null') or not o ? 'referenceHigh'
     or (o->>'referenceLow')::numeric>(o->>'referenceHigh')::numeric then raise exception 'Invalid interval' using errcode='22023';end if;
     codes:=array_append(codes,o->>'code');
   end loop;
 elsif k='vaccination' then
   foreach key in array array['vaccine','dose','location','batch'] loop
     if jsonb_typeof(p->key) is distinct from 'string' then raise exception 'Vaccination field required' using errcode='22023';end if;
   end loop;
   if length(btrim(p->>'vaccine')) not between 1 and 120 or length(btrim(p->>'dose')) not between 1 and 80 or length(btrim(p->>'location')) not between 1 and 160 or length(p->>'batch')>80 then raise exception 'Invalid vaccination' using errcode='22023';end if;
 elsif k='imaging' then
   if coalesce(p->>'modality','') not in ('CT','MR','US','XR','OTHER') or length(btrim(coalesce(p->>'bodyPart',''))) not between 1 and 120 or length(btrim(coalesce(p->>'conclusion',''))) not between 1 and 8000 then raise exception 'Invalid imaging report' using errcode='22023';end if;
   if coalesce(p->>'studyId','')<>'' then perform (p->>'studyId')::uuid;end if;
 else raise exception 'Unknown kind' using errcode='22023';end if;
end $$;

-- Deliberately privileged, narrow gateway. All entry points verify caller identity,
-- live session, current staff membership and patient assignment before accessing data.
create function clinical_private.gateway(action text,args jsonb) returns jsonb
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
     if coalesce(v_kind,'') not in ('heart-rate','resting-heart-rate','sleep') or jsonb_typeof(item->'source') is distinct from 'string' then raise exception 'Invalid sample' using errcode='22023';end if;
     if (item->>'end_at')::timestamptz>now()+interval '5 minutes' or (v_kind='sleep' and item->>'definition'<>'asleep') or (v_kind<>'sleep' and item->>'definition'<>v_kind) then raise exception 'Invalid definition/time' using errcode='22023';end if;
     insert into clinical_private.vitals(patient_id,source_id,kind,value,unit,start_at,end_at,source,definition)
     values(pid,(item->>'source_id')::uuid,v_kind,(item->>'value')::double precision,item->>'unit',(item->>'start_at')::timestamptz,(item->>'end_at')::timestamptz,item->>'source',item->>'definition')
     on conflict(patient_id,source_id) do nothing;
   end loop;
   update clinical_private.vitals set deleted_at=now() where patient_id=pid and source_id in(select value::uuid from jsonb_array_elements_text(args->'deleted')) and deleted_at is null;
   update clinical_private.patients set last_sync_at=now() where id=pid;
   insert into clinical_private.audit(actor_id,patient_id,action) values(actor,pid,'patient.sync_vitals');
   return jsonb_build_object('ok',true);
 end if;
 if auth.jwt()->>'aal' is distinct from 'aal2' or not exists(select 1 from clinical_private.staff where user_id=actor and active) then raise exception 'Staff MFA required' using errcode='42501';end if;
 if action='list' then
   if length(coalesce(args->>'query',''))>120 then raise exception 'Query too long' using errcode='22023';end if;
   insert into clinical_private.audit(actor_id,action) values(actor,'patient.search');
   return coalesce((select jsonb_agg(to_jsonb(x)) from (select p.id,p.display_name,p.identity_label,p.identity_verified,p.last_sync_at from clinical_private.patients p
     where exists(select 1 from clinical_private.assignments a join clinical_private.staff s on s.user_id=a.clinician_id and s.organization_id=a.organization_id
       where a.patient_id=p.id and a.clinician_id=actor and a.active and s.active)
     and (coalesce(args->>'query','')='' or p.identity_label=args->>'query' or position(lower(args->>'query') in lower(p.display_name))>0)
     order by p.display_name,p.id limit 100) x),'[]'::jsonb);
 end if;
 if action in ('patient','save') then pid:=(args->>'patient')::uuid;
 elsif action='publish' then select patient_id into pid from clinical_private.records where id=(args->>'id')::uuid;
 else raise exception 'Unknown action' using errcode='22023';end if;
 select a.organization_id into org from clinical_private.assignments a join clinical_private.staff s on s.user_id=a.clinician_id and s.organization_id=a.organization_id
 where a.patient_id=pid and a.clinician_id=actor and a.active and s.active order by a.organization_id limit 1;
 if org is null then raise exception 'Active care relation required' using errcode='42501';end if;
 if action='patient' then
   insert into clinical_private.audit(actor_id,patient_id,action) values(actor,pid,'patient.open');
   return jsonb_build_object(
     'patient',(select jsonb_build_object('id',id,'display_name',display_name,'identity_label',identity_label,'identity_verified',identity_verified,'last_sync_at',last_sync_at) from clinical_private.patients where id=pid),
     'records',coalesce((select jsonb_agg(to_jsonb(x)-'created_by'-'published_by'-'organization_id') from(select * from clinical_private.records where patient_id=pid and organization_id=org order by created_at desc limit 500)x),'[]'::jsonb),
     'vitals',coalesce((select jsonb_agg(to_jsonb(x)-'patient_id'-'source_id') from(select * from clinical_private.vitals where patient_id=pid and deleted_at is null order by end_at desc limit 500)x),'[]'::jsonb),
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
revoke all on all functions in schema clinical_private from public, anon, authenticated;
grant execute on function clinical_private.gateway(text,jsonb) to authenticated;

create function public.clinician_session() returns jsonb language sql security invoker set search_path=pg_catalog as $$select clinical_private.gateway('session','{}'::jsonb)$$;
create function public.clinician_list_patients(p_query text default '') returns jsonb language sql security invoker set search_path=pg_catalog as $$select clinical_private.gateway('list',jsonb_build_object('query',p_query))$$;
create function public.clinician_patient(p_patient uuid) returns jsonb language sql security invoker set search_path=pg_catalog as $$select clinical_private.gateway('patient',jsonb_build_object('patient',p_patient))$$;
create function public.clinician_save_record(p_patient uuid,p_kind text,p_payload jsonb,p_id uuid,p_revision integer,p_replaces uuid,p_reason text) returns jsonb language sql security invoker set search_path=pg_catalog as $$select clinical_private.gateway('save',jsonb_build_object('patient',p_patient,'kind',p_kind,'payload',p_payload,'id',p_id,'revision',p_revision,'replaces',p_replaces,'reason',p_reason))$$;
create function public.clinician_publish_record(p_id uuid,p_revision integer) returns jsonb language sql security invoker set search_path=pg_catalog as $$select clinical_private.gateway('publish',jsonb_build_object('id',p_id,'revision',p_revision))$$;
create function public.gohealth_patient_data() returns jsonb language sql security invoker set search_path=pg_catalog as $$select clinical_private.gateway('patient_data','{}'::jsonb)$$;
create function public.gohealth_ingest_vitals(p_samples jsonb,p_deleted jsonb) returns jsonb language sql security invoker set search_path=pg_catalog as $$select clinical_private.gateway('ingest',jsonb_build_object('samples',p_samples,'deleted',p_deleted))$$;
revoke all on function public.clinician_session(),public.clinician_list_patients(text),public.clinician_patient(uuid),public.clinician_save_record(uuid,text,jsonb,uuid,integer,uuid,text),public.clinician_publish_record(uuid,integer),public.gohealth_patient_data(),public.gohealth_ingest_vitals(jsonb,jsonb) from public,anon;
grant execute on function public.clinician_session(),public.clinician_list_patients(text),public.clinician_patient(uuid),public.clinician_save_record(uuid,text,jsonb,uuid,integer,uuid,text),public.clinician_publish_record(uuid,integer),public.gohealth_patient_data(),public.gohealth_ingest_vitals(jsonb,jsonb) to authenticated;
