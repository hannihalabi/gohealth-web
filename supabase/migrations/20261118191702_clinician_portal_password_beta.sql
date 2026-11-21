-- A server-owned toggle for the staff and administration portals.
-- New environments require MFA until a database owner enables the password-only beta.
create table clinical_private.portal_settings (
  singleton boolean primary key default true check (singleton),
  mfa_required boolean not null default true
);
alter table clinical_private.portal_settings enable row level security;
revoke all on clinical_private.portal_settings from public, anon, authenticated;
insert into clinical_private.portal_settings default values;

create function clinical_private.portal_mfa_required() returns boolean
language sql stable set search_path = pg_catalog as $$
  select coalesce(
    (select s.mfa_required from clinical_private.portal_settings s where s.singleton),
    true
  )
$$;

create function clinical_private.portal_has_password_proof() returns boolean
language sql stable set search_path = pg_catalog as $$
  select coalesce(auth.jwt()->'amr' @> '[{"method":"password"}]'::jsonb, false)
$$;

create function clinical_private.portal_assurance_sufficient() returns boolean
language sql stable set search_path = pg_catalog as $$
  select case auth.jwt()->>'aal'
    when 'aal2' then true
    when 'aal1' then not clinical_private.portal_mfa_required()
      and clinical_private.portal_has_password_proof()
    else false
  end
$$;

revoke all on function clinical_private.portal_mfa_required(),
  clinical_private.portal_has_password_proof(),
  clinical_private.portal_assurance_sufficient() from public, anon, authenticated;

-- Use the same setting for UI session discovery and enforcement at the gateways.
-- Membership, care relationships, live sessions, and record permissions are checked as before.
create or replace function clinical_private.portal_session() returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=clinical_private.live_actor(); clinical jsonb; admin_name text; orgs jsonb;
begin
 clinical:=clinical_private.gateway('session','{}');
 select display_name into admin_name from clinical_private.administrators where user_id=actor and active order by organization_id limit 1;
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) order by o.name),'[]') into orgs
 from clinical_private.administrators a join clinical_private.organizations o on o.id=a.organization_id where a.user_id=actor and a.active;
 return clinical||jsonb_build_object('access',coalesce((clinical->>'staff')::boolean,false) or admin_name is not null,
 'clinical',coalesce((clinical->>'staff')::boolean,false),'admin',admin_name is not null,'userId',actor,
 'name',coalesce(admin_name,clinical->>'name'),'role',case when clinical->>'staff'='true' then clinical->>'role' else 'admin' end,
 'organizations',orgs,'aal',auth.jwt()->>'aal',
 'mfa_required',clinical_private.portal_mfa_required(),'password_session',clinical_private.portal_has_password_proof());
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

create or replace function clinical_private.administration(action text,args jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=clinical_private.live_actor(); org uuid; target uuid; pid uuid; row_id uuid; n integer; expected integer;
 invitation clinical_private.staff_invitations; email_address text; full_name text; chosen_role text; flag boolean; result jsonb;
begin
 delete from clinical_private.request_limits where actor_id=actor and bucket<date_trunc('minute',now())-interval '1 minute';
 insert into clinical_private.request_limits values(actor,date_trunc('minute',now()),1)
 on conflict(actor_id,bucket) do update set requests=clinical_private.request_limits.requests+1 returning requests into n;
 if n>120 then raise exception 'Request limit' using errcode='42501';end if;
 if action in ('pending','accept') then
   select lower(email) into email_address from auth.users where id=actor and email_confirmed_at is not null;
   if email_address is null then raise exception 'Verified email required' using errcode='42501';end if;
   if action='pending' then
     return coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'name',i.display_name,'role',i.role,'organization',o.name,'expiresAt',i.expires_at) order by i.created_at)
     from clinical_private.staff_invitations i join clinical_private.organizations o on o.id=i.organization_id
     where i.email=email_address and i.accepted_at is null and i.cancelled_at is null and i.expires_at>now()
     and ((i.bootstrap and not exists(select 1 from clinical_private.administrators a where a.organization_id=i.organization_id))
     or exists(select 1 from clinical_private.administrators a where a.user_id=i.invited_by and a.organization_id=i.organization_id and a.active))),'[]');
   end if;
   row_id:=(args->>'id')::uuid;
   select organization_id into org from clinical_private.staff_invitations where id=row_id and email=email_address;
   if org is null then raise exception 'Invitation unavailable' using errcode='42501';end if;
   perform pg_advisory_xact_lock(hashtextextended('admin:'||org::text,0));
   select * into invitation from clinical_private.staff_invitations where id=row_id and email=email_address and accepted_at is null and cancelled_at is null and expires_at>now() for update;
   if invitation.id is null then raise exception 'Invitation unavailable' using errcode='42501';end if;
   if invitation.bootstrap then
     if exists(select 1 from clinical_private.administrators where organization_id=org) then raise exception 'Bootstrap already completed' using errcode='42501';end if;
   elsif not exists(select 1 from clinical_private.administrators where organization_id=org and user_id=invitation.invited_by and active)
   or invitation.invited_by=actor then raise exception 'Inviter no longer authorized' using errcode='42501';end if;
   if invitation.role='admin' then
     insert into clinical_private.administrators(user_id,organization_id,display_name) values(actor,org,invitation.display_name)
     on conflict(user_id,organization_id) do update set active=true,display_name=excluded.display_name,revision=clinical_private.administrators.revision+1;
   else
     insert into clinical_private.staff(user_id,organization_id,display_name,role) values(actor,org,invitation.display_name,invitation.role)
     on conflict(user_id,organization_id) do update set active=true,display_name=excluded.display_name,role=excluded.role,revision=clinical_private.staff.revision+1;
   end if;
   update clinical_private.staff_invitations set accepted_at=now(),accepted_by=actor,revision=revision+1 where id=row_id;
   insert into clinical_private.administration_audit(organization_id,actor_id,action,subject_id,details) values(org,actor,'invitation.accept',row_id,jsonb_build_object('role',invitation.role));
   return clinical_private.portal_session();
 end if;
 org:=(args->>'organizationId')::uuid;
 if org is null or not clinical_private.portal_assurance_sufficient() then
   raise exception 'Administrator authentication required' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('admin:'||org::text,0));
 if not exists(select 1 from clinical_private.administrators where user_id=actor and organization_id=org and active) then raise exception 'Administrator required' using errcode='42501';end if;
 if action='snapshot' then
   if length(coalesce(args->>'query',''))>120 then raise exception 'Query too long' using errcode='22023';end if;
   insert into clinical_private.administration_audit(organization_id,actor_id,action) values(org,actor,'administration.open');
   return jsonb_build_object(
    'members',coalesce((select jsonb_agg(to_jsonb(x)) from (
      select s.user_id,s.display_name,s.role,s.active,s.revision,u.email from clinical_private.staff s join auth.users u on u.id=s.user_id where s.organization_id=org
      union all select a.user_id,a.display_name,'admin',a.active,a.revision,u.email from clinical_private.administrators a join auth.users u on u.id=a.user_id where a.organization_id=org
      order by display_name limit 500)x),'[]'),
    'invitations',coalesce((select jsonb_agg(to_jsonb(x)) from(select id,email,display_name,role,expires_at,accepted_at,cancelled_at,revision from clinical_private.staff_invitations where organization_id=org order by created_at desc limit 100)x),'[]'),
    'patients',coalesce((select jsonb_agg(to_jsonb(x)) from(select p.id,p.display_name,p.identity_label,p.identity_verified,m.active,m.revision from clinical_private.organization_patients m join clinical_private.patients p on p.id=m.patient_id
       where m.organization_id=org and (coalesce(args->>'query','')='' or p.identity_label=args->>'query' or position(lower(args->>'query') in lower(p.display_name))>0) order by p.display_name,p.id limit 100)x),'[]'),
    'assignments',coalesce((select jsonb_agg(to_jsonb(x)) from(select a.patient_id,a.clinician_id,a.active,a.revision from clinical_private.assignments a
      where a.organization_id=org and a.patient_id in(select p.id from clinical_private.organization_patients m join clinical_private.patients p on p.id=m.patient_id
      where m.organization_id=org and (coalesce(args->>'query','')='' or p.identity_label=args->>'query' or position(lower(args->>'query') in lower(p.display_name))>0) order by p.display_name,p.id limit 100)
      order by a.patient_id,a.clinician_id limit 500)x),'[]'),
    'audit',coalesce((select jsonb_agg(to_jsonb(x)) from(select a.action,a.created_at,a.actor_id,a.subject_id,a.details from clinical_private.administration_audit a where a.organization_id=org order by a.created_at desc,a.id desc limit 100)x),'[]'));
 end if;
 if action='invite' then
   email_address:=lower(btrim(args->>'email')); full_name:=btrim(args->>'name'); chosen_role:=args->>'role';
   if email_address is null or length(email_address) not between 3 and 254 or email_address !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or full_name is null or length(full_name) not between 1 and 120 or coalesce(chosen_role,'') not in ('doctor','nurse','admin')
    or (chosen_role<>'admin' and coalesce((args->>'identityAttested')::boolean,false)=false)
    or exists(select 1 from auth.users where id=actor and lower(email)=email_address) then raise exception 'Invalid invitation' using errcode='22023';end if;
   update clinical_private.staff_invitations set cancelled_at=now(),revision=revision+1 where organization_id=org and email=email_address and accepted_at is null and cancelled_at is null;
   insert into clinical_private.staff_invitations(organization_id,email,display_name,role,invited_by,identity_attested)
   values(org,email_address,full_name,chosen_role,actor,coalesce((args->>'identityAttested')::boolean,false)) returning id into row_id;
 elsif action='cancelInvitation' then
   row_id:=(args->>'id')::uuid; expected:=(args->>'revision')::integer;
   update clinical_private.staff_invitations set cancelled_at=now(),revision=revision+1 where id=row_id and organization_id=org and revision=expected and accepted_at is null and cancelled_at is null;
   get diagnostics n=row_count;if n<>1 then raise exception 'Revision conflict' using errcode='40001';end if;
 elsif action='member' then
   target:=(args->>'userId')::uuid; expected:=(args->>'revision')::integer; chosen_role:=args->>'role'; full_name:=btrim(args->>'name');
   if target is null or (target=actor and not (args->>'memberType'='admin' and chosen_role='admin' and args->'active'='true'::jsonb)) or expected is null or length(coalesce(full_name,'')) not between 1 and 120
    or jsonb_typeof(args->'active') is distinct from 'boolean' or coalesce(chosen_role,'') not in ('doctor','nurse','admin')
    or (chosen_role<>'admin' and coalesce((args->>'identityAttested')::boolean,false)=false) then raise exception 'Invalid member change' using errcode='22023';end if;
   flag:=(args->>'active')::boolean;
   if args->>'memberType'='admin' and chosen_role='admin' then
     update clinical_private.administrators set display_name=full_name,active=flag,revision=revision+1 where user_id=target and organization_id=org and revision=expected;
   elsif args->>'memberType'='clinical' and chosen_role in ('doctor','nurse') then
     update clinical_private.staff set display_name=full_name,role=chosen_role,active=flag,revision=revision+1 where user_id=target and organization_id=org and revision=expected;
   else raise exception 'Invalid member type' using errcode='22023';end if;
   get diagnostics n=row_count;if n<>1 then raise exception 'Revision conflict' using errcode='40001';end if;
   -- An older pending grant must never undo a later revocation or role change.
   update clinical_private.staff_invitations set cancelled_at=now(),revision=revision+1
   where organization_id=org and email=(select lower(email) from auth.users where id=target)
    and accepted_at is null and cancelled_at is null
    and ((args->>'memberType'='admin' and role='admin') or (args->>'memberType'='clinical' and role in ('doctor','nurse')));
   if not flag then
     if args->>'memberType'='clinical' then
       update clinical_private.assignments set active=false,revision=revision+1 where organization_id=org and clinician_id=target and active;
     else
       update clinical_private.staff_invitations set cancelled_at=now(),revision=revision+1 where organization_id=org and invited_by=target and accepted_at is null and cancelled_at is null;
     end if;
   end if;
   row_id:=target;
 elsif action='patient' then
   full_name:=btrim(args->>'name'); email_address:=lower(btrim(args->>'email'));
   if length(coalesce(full_name,'')) not between 1 and 160 or length(btrim(coalesce(args->>'identity',''))) not between 3 and 40
    or coalesce((args->>'identityAttested')::boolean,false)=false then raise exception 'Verified identity required' using errcode='22023';end if;
   select id into target from auth.users where lower(email)=email_address and email_confirmed_at is not null and (banned_until is null or banned_until<now());
   if target is null or exists(select 1 from clinical_private.patients where account_id=target or identity_label=btrim(args->>'identity')) then raise exception 'Patient account unavailable' using errcode='22023';end if;
   insert into clinical_private.patients(account_id,display_name,identity_label,identity_verified) values(target,full_name,btrim(args->>'identity'),true) returning id into pid;
   insert into clinical_private.organization_patients(organization_id,patient_id,verified_by,verified_at) values(org,pid,actor,now());
   row_id:=pid;
 elsif action='assignment' then
   pid:=(args->>'patientId')::uuid; target:=(args->>'userId')::uuid; expected:=(args->>'revision')::integer;
   if target is null or target=actor or expected is null or jsonb_typeof(args->'active') is distinct from 'boolean'
    or not exists(select 1 from clinical_private.organization_patients where organization_id=org and patient_id=pid and active)
    or not exists(select 1 from clinical_private.staff where organization_id=org and user_id=target and active) then raise exception 'Assignment unavailable' using errcode='42501';end if;
   flag:=(args->>'active')::boolean;
   if expected=0 then
     insert into clinical_private.assignments(patient_id,organization_id,clinician_id,active) values(pid,org,target,flag)
     on conflict(patient_id,organization_id,clinician_id) do nothing;
   else
     update clinical_private.assignments set active=flag,revision=revision+1 where patient_id=pid and organization_id=org and clinician_id=target and revision=expected;
   end if;
   get diagnostics n=row_count;if n<>1 then raise exception 'Revision conflict' using errcode='40001';end if;
   row_id:=pid;
 else raise exception 'Unknown administration action' using errcode='22023';end if;
 insert into clinical_private.administration_audit(organization_id,actor_id,action,subject_id,details)
 values(org,actor,'administration.'||action,row_id,jsonb_strip_nulls(jsonb_build_object('role',chosen_role,'active',flag,'clinicianId',case when action='assignment' then target else null end)));
 return jsonb_build_object('ok',true);
end $$;
