-- Declarative system inventory, separate from uptime monitoring and patient data.
-- Operators update this registry as integrations are added, removed or connected.
create table clinical_private.system_integrations (
  id text primary key check (id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  name text not null check (length(btrim(name)) between 1 and 80),
  kind text not null check (kind in ('admin','clinician','app','website','service')),
  description text not null check (length(description) <= 400),
  connected boolean not null default false,
  enabled boolean not null default true,
  sort_order integer not null default 100,
  updated_at timestamptz not null default now()
);
alter table clinical_private.system_integrations enable row level security;
revoke all on clinical_private.system_integrations from public, anon, authenticated;

insert into clinical_private.system_integrations(id,name,kind,description,connected,sort_order) values
 ('admin','Admin-portalen','admin','Personal, behörigheter och patienttilldelning.',true,10),
 ('clinician','Clinician-portalen','clinician','Vårdteamets arbetsyta för patientuppföljning.',true,20),
 ('hemlakare','Hemläkare.se','website','Publik webbplats. Ännu ingen databasanslutning.',false,30),
 ('ios','GoHealth iOS','app','Patientappen med delade hälsodata och kliniska resultat.',true,40);

create function clinical_private.touch_system_integration() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin new.updated_at:=now(); return new; end $$;
revoke all on function clinical_private.touch_system_integration() from public,anon,authenticated;
create trigger touch_system_integration before update on clinical_private.system_integrations
for each row execute function clinical_private.touch_system_integration();

create function clinical_private.system_overview(org uuid, member_portal text, member_offset integer) returns jsonb
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
     select a.user_id,a.display_name,'admin' as role,a.active,a.revision,u.email
       from clinical_private.administrators a join auth.users u on u.id=a.user_id
       where a.organization_id=org and member_portal='admin'
     union all
     select s.user_id,s.display_name,s.role,s.active,s.revision,u.email
       from clinical_private.staff s join auth.users u on u.id=s.user_id
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
revoke all on function clinical_private.system_overview(uuid,text,integer) from public,anon,authenticated;
grant execute on function clinical_private.system_overview(uuid,text,integer) to authenticated;
create function public.clinician_system_overview(p_organization_id uuid,p_member_portal text default 'clinician',p_member_offset integer default 0)
returns jsonb language sql security invoker set search_path=pg_catalog as $$
 select clinical_private.system_overview(p_organization_id,p_member_portal,p_member_offset)
$$;
revoke all on function public.clinician_system_overview(uuid,text,integer) from public,anon;
grant execute on function public.clinician_system_overview(uuid,text,integer) to authenticated;
