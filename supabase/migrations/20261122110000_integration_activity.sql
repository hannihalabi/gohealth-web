-- Status per system comes from real activity, not a hand-set flag.
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
