-- Everyone works under a doctor: nurses, psychologists and medical secretaries can all belong to a doctor's team.
-- Team membership is organisational only and still never grants patient access (that needs an assignment).
-- care_teams.nurse_id keeps its name and now holds any non-doctor team member.
create or replace function clinical_private.set_care_team(org uuid,nurse uuid,doctor uuid,expected_revision integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=clinical_private.live_actor(); n integer; current_revision integer; previous_doctor uuid;
begin
 if not clinical_private.portal_assurance_sufficient() or not exists(
  select 1 from clinical_private.administrators where organization_id=org and user_id=actor and active
 ) then raise exception 'Administrator required' using errcode='42501';end if;
 delete from clinical_private.request_limits where actor_id=actor and bucket<date_trunc('minute',now())-interval '1 minute';
 insert into clinical_private.request_limits values(actor,date_trunc('minute',now()),1)
 on conflict(actor_id,bucket) do update set requests=clinical_private.request_limits.requests+1 returning requests into n;
 if n>120 then raise exception 'Request limit' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('admin:'||org::text,0));
 if not exists(select 1 from clinical_private.staff where organization_id=org and user_id=nurse and role in ('nurse','psychologist','secretary') and active)
 or (doctor is not null and not exists(select 1 from clinical_private.staff where organization_id=org and user_id=doctor and role='doctor' and active))
 then raise exception 'Active team member and doctor required' using errcode='42501';end if;
 select revision,doctor_id into current_revision,previous_doctor from clinical_private.care_teams where organization_id=org and nurse_id=nurse;
 if expected_revision is null or expected_revision<0 or coalesce(current_revision,0)<>expected_revision
 then raise exception 'Revision conflict' using errcode='40001';end if;
 insert into clinical_private.care_teams(organization_id,nurse_id,doctor_id,updated_by) values(org,nurse,doctor,actor)
 on conflict(organization_id,nurse_id) do update set doctor_id=excluded.doctor_id,
 revision=clinical_private.care_teams.revision+1,updated_at=now(),updated_by=actor;
 insert into clinical_private.administration_audit(organization_id,actor_id,action,subject_id,details)
 values(org,actor,'administration.careTeam',nurse,jsonb_build_object('doctorId',doctor,'previousDoctorId',previous_doctor));
 return jsonb_build_object('ok',true);
end $$;

create or replace function clinical_private.clear_invalid_care_teams() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 update clinical_private.care_teams set doctor_id=null,revision=revision+1,updated_at=now(),updated_by=null
 where organization_id=new.organization_id and doctor_id is not null and (
  (nurse_id=new.user_id and (not new.active or new.role not in ('nurse','psychologist','secretary'))) or
  (doctor_id=new.user_id and (not new.active or new.role<>'doctor'))
 );
 return new;
end $$;

create or replace function clinical_private.system_overview(org uuid, member_portal text, member_offset integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=clinical_private.live_actor(); n integer;
begin
 if not clinical_private.portal_assurance_sufficient() or not exists (
   select 1 from clinical_private.administrators where user_id=actor and organization_id=org and active
 ) then raise exception 'Administrator required' using errcode='42501'; end if;
 if member_portal is null or member_portal not in ('admin','clinician') or member_offset is null or member_offset<0 or member_offset>100000
 then raise exception 'Invalid overview page' using errcode='22023'; end if;
 delete from clinical_private.request_limits where actor_id=actor and bucket<date_trunc('minute',now())-interval '1 minute';
 insert into clinical_private.request_limits values(actor,date_trunc('minute',now()),1)
 on conflict(actor_id,bucket) do update set requests=clinical_private.request_limits.requests+1 returning requests into n;
 if n>120 then raise exception 'Request limit' using errcode='42501'; end if;
 return jsonb_build_object(
   'checkedAt',now(),
   'integrations',coalesce((select jsonb_agg((to_jsonb(i)-'enabled'-'sort_order')||jsonb_build_object('last_activity_at',
       case i.kind
         when 'admin' then (select max(created_at) from clinical_private.administration_audit where organization_id=org)
         when 'clinician' then (select max(a.created_at) from clinical_private.audit a
           where a.actor_id in (select user_id from clinical_private.staff where organization_id=org))
         when 'app' then (select max(p.last_sync_at) from clinical_private.patients p
           join clinical_private.organization_patients op on op.patient_id=p.id where op.organization_id=org)
         when 'website' then (select max(created_at) from clinical_private.applications)
       end) order by i.sort_order,i.id)
     from clinical_private.system_integrations i where i.enabled),'[]'::jsonb),
   'memberPortal',member_portal,'memberOffset',member_offset,'memberLimit',50,
   'memberTotal',case when member_portal='admin' then
     (select count(*) from clinical_private.administrators where organization_id=org)
     else (select count(*) from clinical_private.staff where organization_id=org) end,
   'members',coalesce((select jsonb_agg(to_jsonb(m)) from (
     select a.user_id,a.display_name,'admin' as role,a.active,a.revision,u.email,
       null::bigint as patient_count,null::uuid as doctor_id,0 as team_revision
       from clinical_private.administrators a join auth.users u on u.id=a.user_id
       where a.organization_id=org and member_portal='admin'
     union all
     select s.user_id,s.display_name,s.role,s.active,s.revision,u.email,
       (select count(distinct a.patient_id) from clinical_private.assignments a
        join clinical_private.organization_patients op on op.patient_id=a.patient_id and op.organization_id=a.organization_id and op.active
        where a.organization_id=org and a.clinician_id=s.user_id and a.active and s.active) as patient_count,
       case when s.role<>'doctor' then t.doctor_id else null end as doctor_id,
       case when s.role<>'doctor' then coalesce(t.revision,0) else 0 end as team_revision
       from clinical_private.staff s join auth.users u on u.id=s.user_id
       left join clinical_private.care_teams t on t.organization_id=s.organization_id and t.nurse_id=s.user_id
       where s.organization_id=org and member_portal='clinician'
     order by display_name,user_id limit 50 offset member_offset
   )m),'[]'::jsonb),
   'counts',jsonb_build_object(
     'admin',(select count(*) from clinical_private.administrators where organization_id=org and active),
     'clinician',(select count(*) from clinical_private.staff where organization_id=org and active),
     'pending',(select count(*) from clinical_private.staff_invitations where organization_id=org
       and accepted_at is null and cancelled_at is null and expires_at>now())
   )
 );
end $$;

-- The staff list carries each member's doctor, so the team can be chosen in the member dialog.
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
      select s.user_id,s.display_name,s.role,s.active,s.revision,u.email,t.doctor_id,coalesce(t.revision,0) as team_revision
      from clinical_private.staff s join auth.users u on u.id=s.user_id
      left join clinical_private.care_teams t on t.organization_id=s.organization_id and t.nurse_id=s.user_id where s.organization_id=org
      union all select a.user_id,a.display_name,'admin',a.active,a.revision,u.email,null::uuid,0 from clinical_private.administrators a join auth.users u on u.id=a.user_id where a.organization_id=org
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
    or full_name is null or length(full_name) not between 1 and 120 or coalesce(chosen_role,'') not in ('doctor','nurse','psychologist','secretary','admin')
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
    or jsonb_typeof(args->'active') is distinct from 'boolean' or coalesce(chosen_role,'') not in ('doctor','nurse','psychologist','secretary','admin')
    or (chosen_role<>'admin' and coalesce((args->>'identityAttested')::boolean,false)=false) then raise exception 'Invalid member change' using errcode='22023';end if;
   flag:=(args->>'active')::boolean;
   if args->>'memberType'='admin' and chosen_role='admin' then
     update clinical_private.administrators set display_name=full_name,active=flag,revision=revision+1 where user_id=target and organization_id=org and revision=expected;
   elsif args->>'memberType'='clinical' and chosen_role in ('doctor','nurse','psychologist','secretary') then
     update clinical_private.staff set display_name=full_name,role=chosen_role,active=flag,revision=revision+1 where user_id=target and organization_id=org and revision=expected;
   else raise exception 'Invalid member type' using errcode='22023';end if;
   get diagnostics n=row_count;if n<>1 then raise exception 'Revision conflict' using errcode='40001';end if;
   -- An older pending grant must never undo a later revocation or role change.
   update clinical_private.staff_invitations set cancelled_at=now(),revision=revision+1
   where organization_id=org and email=(select lower(email) from auth.users where id=target)
    and accepted_at is null and cancelled_at is null
    and ((args->>'memberType'='admin' and role='admin') or (args->>'memberType'='clinical' and role in ('doctor','nurse','psychologist','secretary')));
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
