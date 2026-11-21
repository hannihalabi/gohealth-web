-- Organisation administration is separate from clinical access.
-- Filename matches the applied GoHealth Dev migration history.
create table clinical_private.administrators (
 user_id uuid not null references auth.users(id),
 organization_id uuid not null references clinical_private.organizations(id),
 display_name text not null check(length(btrim(display_name)) between 1 and 120),
 active boolean not null default true, revision integer not null default 1,
 primary key(user_id,organization_id), check(revision>0)
);
create table clinical_private.organization_patients (
 organization_id uuid not null references clinical_private.organizations(id),
 patient_id uuid not null references clinical_private.patients(id),
 active boolean not null default true, revision integer not null default 1,
 verified_by uuid references auth.users(id), verified_at timestamptz,
 primary key(organization_id,patient_id), check(revision>0)
);
insert into clinical_private.organization_patients(organization_id,patient_id)
select distinct organization_id,patient_id from clinical_private.assignments on conflict do nothing;
insert into clinical_private.organization_patients(organization_id,patient_id)
select distinct organization_id,patient_id from clinical_private.records on conflict do nothing;
create table clinical_private.staff_invitations (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_private.organizations(id),
 email text not null check(email=lower(btrim(email)) and length(email) between 3 and 254 and position('@' in email)>1),
 display_name text not null check(length(btrim(display_name)) between 1 and 120),
 role text not null check(role in ('doctor','nurse','admin')),
 invited_by uuid references auth.users(id), bootstrap boolean not null default false,
 identity_attested boolean not null,
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '7 days',
 accepted_at timestamptz, accepted_by uuid references auth.users(id), cancelled_at timestamptz,
 revision integer not null default 1 check(revision>0),
 check((bootstrap and invited_by is null and role='admin') or (not bootstrap and invited_by is not null)),
 check(role='admin' or identity_attested),
 check((accepted_at is null and accepted_by is null) or (accepted_at is not null and accepted_by is not null))
);
create unique index one_open_staff_invitation on clinical_private.staff_invitations(organization_id,email)
where accepted_at is null and cancelled_at is null;
create index staff_invitation_email on clinical_private.staff_invitations(email) where accepted_at is null and cancelled_at is null;
create table clinical_private.administration_audit (
 id bigint generated always as identity primary key,
 organization_id uuid not null references clinical_private.organizations(id),
 actor_id uuid references auth.users(id), action text not null,
 subject_id uuid, details jsonb not null default '{}', created_at timestamptz not null default now()
);
create index administration_audit_org on clinical_private.administration_audit(organization_id,created_at desc);
alter table clinical_private.staff add column revision integer not null default 1 check(revision>0);
alter table clinical_private.assignments add column revision integer not null default 1 check(revision>0);
alter table clinical_private.administrators enable row level security;
alter table clinical_private.organization_patients enable row level security;
alter table clinical_private.staff_invitations enable row level security;
alter table clinical_private.administration_audit enable row level security;
revoke all on all tables in schema clinical_private from public,anon,authenticated;
revoke all on all sequences in schema clinical_private from public,anon,authenticated;

create function clinical_private.live_actor() returns uuid language plpgsql set search_path=pg_catalog as $$
declare actor uuid:=auth.uid();
begin
 if actor is null or not exists(select 1 from auth.users where id=actor and (banned_until is null or banned_until<now()))
 or not exists(select 1 from auth.sessions where id=(auth.jwt()->>'session_id')::uuid and user_id=actor and (not_after is null or not_after>now()))
 then raise exception 'Valid session required' using errcode='42501';end if;
 return actor;
end $$;
create function clinical_private.portal_session() returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=clinical_private.live_actor(); clinical jsonb; admin_name text; orgs jsonb;
begin
 clinical:=clinical_private.gateway('session','{}');
 select display_name into admin_name from clinical_private.administrators where user_id=actor and active order by organization_id limit 1;
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) order by o.name),'[]') into orgs
 from clinical_private.administrators a join clinical_private.organizations o on o.id=a.organization_id where a.user_id=actor and a.active;
 return clinical||jsonb_build_object('access',coalesce((clinical->>'staff')::boolean,false) or admin_name is not null,
 'clinical',coalesce((clinical->>'staff')::boolean,false),'admin',admin_name is not null,'userId',actor,
 'name',coalesce(admin_name,clinical->>'name'),'role',case when clinical->>'staff'='true' then clinical->>'role' else 'admin' end,
 'organizations',orgs,'aal',auth.jwt()->>'aal');
end $$;
create or replace function public.clinician_session() returns jsonb language sql security invoker set search_path=pg_catalog
as $$select clinical_private.portal_session()$$;

create function clinical_private.administration(action text,args jsonb) returns jsonb
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
 if org is null or auth.jwt()->>'aal' is distinct from 'aal2' then raise exception 'Administrator MFA required' using errcode='42501';end if;
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
revoke all on function clinical_private.live_actor(),clinical_private.portal_session(),clinical_private.administration(text,jsonb) from public,anon,authenticated;
grant execute on function clinical_private.portal_session(),clinical_private.administration(text,jsonb) to authenticated;
create function public.clinician_administration(p_action text,p_args jsonb) returns jsonb language sql security invoker set search_path=pg_catalog
as $$select clinical_private.administration(p_action,p_args)$$;
revoke all on function public.clinician_administration(text,jsonb) from public,anon;
grant execute on function public.clinician_administration(text,jsonb) to authenticated;
