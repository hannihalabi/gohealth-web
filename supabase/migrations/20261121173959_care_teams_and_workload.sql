-- Organisational affiliation only. Team membership never grants patient access.
create table clinical_private.care_teams (
 organization_id uuid not null references clinical_private.organizations(id),
 nurse_id uuid not null,
 doctor_id uuid,
 revision integer not null default 1 check(revision>0),
 updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id),
 primary key(organization_id,nurse_id),
 foreign key(nurse_id,organization_id) references clinical_private.staff(user_id,organization_id),
 foreign key(doctor_id,organization_id) references clinical_private.staff(user_id,organization_id),
 check(doctor_id is null or doctor_id<>nurse_id)
);
create index care_teams_doctor on clinical_private.care_teams(organization_id,doctor_id) where doctor_id is not null;
alter table clinical_private.care_teams enable row level security;
revoke all on clinical_private.care_teams from public,anon,authenticated;

create function clinical_private.set_care_team(org uuid,nurse uuid,doctor uuid,expected_revision integer)
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
 if not exists(select 1 from clinical_private.staff where organization_id=org and user_id=nurse and role='nurse' and active)
 or (doctor is not null and not exists(select 1 from clinical_private.staff where organization_id=org and user_id=doctor and role='doctor' and active))
 then raise exception 'Active nurse and doctor required' using errcode='42501';end if;
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
revoke all on function clinical_private.set_care_team(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function clinical_private.set_care_team(uuid,uuid,uuid,integer) to authenticated;
create function public.clinician_set_care_team(p_organization_id uuid,p_nurse_id uuid,p_doctor_id uuid,p_revision integer)
returns jsonb language sql security invoker set search_path=pg_catalog as $$
 select clinical_private.set_care_team(p_organization_id,p_nurse_id,p_doctor_id,p_revision)
$$;
revoke all on function public.clinician_set_care_team(uuid,uuid,uuid,integer) from public,anon;
grant execute on function public.clinician_set_care_team(uuid,uuid,uuid,integer) to authenticated;

-- Clear affiliations when either clinical role changes or is deactivated.
-- Keep a revision tombstone so stale edits cannot silently recreate an old link.
create function clinical_private.clear_invalid_care_teams() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 update clinical_private.care_teams set doctor_id=null,revision=revision+1,updated_at=now(),updated_by=null
 where organization_id=new.organization_id and doctor_id is not null and (
  (nurse_id=new.user_id and (not new.active or new.role<>'nurse')) or
  (doctor_id=new.user_id and (not new.active or new.role<>'doctor'))
 );
 return new;
end $$;
revoke all on function clinical_private.clear_invalid_care_teams() from public,anon,authenticated;
create trigger clear_invalid_care_teams after update of active,role on clinical_private.staff
for each row when(old.active is distinct from new.active or old.role is distinct from new.role)
execute function clinical_private.clear_invalid_care_teams();

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
   'integrations',coalesce((select jsonb_agg(to_jsonb(i)-'enabled'-'sort_order' order by i.sort_order,i.id)
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
       case when s.role='nurse' then t.doctor_id else null end as doctor_id,
       case when s.role='nurse' then coalesce(t.revision,0) else 0 end as team_revision
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
