-- Patient pipeline: website applications and app onboarding awaiting approval.
create table clinical_private.patient_signups (
 id uuid primary key default gen_random_uuid(),
 account_id uuid not null unique references auth.users(id) on delete cascade,
 display_name text not null check(length(btrim(display_name)) between 1 and 160),
 identity_label text not null check(length(btrim(identity_label)) between 3 and 40),
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 created_at timestamptz not null default now(),
 decided_at timestamptz, decided_by uuid references auth.users(id),
 revision integer not null default 1 check(revision>0),
 check((status='pending' and decided_at is null) or (status<>'pending' and decided_at is not null))
);
create index patient_signups_pending on clinical_private.patient_signups(created_at) where status='pending';
create table clinical_private.applications (
 id uuid primary key default gen_random_uuid(),
 name text not null check(length(btrim(name)) between 1 and 160),
 email text not null check(email=lower(btrim(email)) and length(email) between 3 and 254 and position('@' in email)>1),
 message text check(message is null or length(message)<=2000),
 status text not null default 'new' check(status in ('new','handled','dismissed')),
 created_at timestamptz not null default now(),
 handled_at timestamptz, handled_by uuid references auth.users(id),
 revision integer not null default 1 check(revision>0),
 check((status='new' and handled_at is null) or (status<>'new' and handled_at is not null))
);
create unique index one_open_application on clinical_private.applications(email) where status='new';
create index applications_new on clinical_private.applications(created_at) where status='new';
alter table clinical_private.patient_signups enable row level security;
alter table clinical_private.applications enable row level security;
revoke all on clinical_private.patient_signups,clinical_private.applications from public,anon,authenticated;

-- Called by the iOS app when the signed-in patient finishes onboarding.
create function clinical_private.complete_onboarding(p_name text,p_identity text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=clinical_private.live_actor(); n integer; found clinical_private.patient_signups;
 ident text:=regexp_replace(btrim(coalesce(p_identity,'')),'^(\d{8})[-+ ]?(\d{4})$','\1\2');
begin
 delete from clinical_private.request_limits where actor_id=actor and bucket<date_trunc('minute',now())-interval '1 minute';
 insert into clinical_private.request_limits values(actor,date_trunc('minute',now()),1)
 on conflict(actor_id,bucket) do update set requests=clinical_private.request_limits.requests+1 returning requests into n;
 if n>30 then raise exception 'Request limit' using errcode='42501';end if;
 if not exists(select 1 from auth.users where id=actor and email_confirmed_at is not null)
  or length(btrim(coalesce(p_name,''))) not between 1 and 160 or length(ident) not between 3 and 40
 then raise exception 'Invalid onboarding' using errcode='22023';end if;
 if exists(select 1 from clinical_private.patients where account_id=actor) then return jsonb_build_object('status','approved');end if;
 insert into clinical_private.patient_signups(account_id,display_name,identity_label)
 values(actor,btrim(p_name),ident) on conflict(account_id) do nothing;
 select * into found from clinical_private.patient_signups where account_id=actor;
 return jsonb_build_object('status',found.status);
end $$;
revoke all on function clinical_private.complete_onboarding(text,text) from public,anon,authenticated;
grant execute on function clinical_private.complete_onboarding(text,text) to authenticated;
create function public.gohealth_complete_onboarding(p_name text,p_identity text) returns jsonb
language sql security invoker set search_path=pg_catalog as $$select clinical_private.complete_onboarding(p_name,p_identity)$$;
revoke all on function public.gohealth_complete_onboarding(text,text) from public,anon;
grant execute on function public.gohealth_complete_onboarding(text,text) to authenticated;

-- Lets the app show where the signed-in patient stands: none, pending, approved or rejected.
create function clinical_private.onboarding_status() returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=clinical_private.live_actor(); found text;
begin
 if exists(select 1 from clinical_private.patients where account_id=actor) then return jsonb_build_object('status','approved');end if;
 select status into found from clinical_private.patient_signups where account_id=actor;
 return jsonb_build_object('status',coalesce(found,'none'));
end $$;
revoke all on function clinical_private.onboarding_status() from public,anon,authenticated;
grant execute on function clinical_private.onboarding_status() to authenticated;
create function public.gohealth_onboarding_status() returns jsonb
language sql security invoker set search_path=pg_catalog as $$select clinical_private.onboarding_status()$$;
revoke all on function public.gohealth_onboarding_status() from public,anon;
grant execute on function public.gohealth_onboarding_status() to authenticated;

-- Called by the hemlakare.se application form (anonymous).
create function clinical_private.submit_application(p_name text,p_email text,p_message text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare mail text:=lower(btrim(coalesce(p_email,'')));
begin
 if length(btrim(coalesce(p_name,''))) not between 1 and 160 or length(mail) not between 3 and 254
  or mail !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(coalesce(p_message,''))>2000
 then raise exception 'Invalid application' using errcode='22023';end if;
 if (select count(*) from clinical_private.applications where created_at>now()-interval '1 hour')>=100
 then raise exception 'Request limit' using errcode='42501';end if;
 insert into clinical_private.applications(name,email,message) values(btrim(p_name),mail,nullif(btrim(coalesce(p_message,'')),''))
 on conflict(email) where status='new' do nothing;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function clinical_private.submit_application(text,text,text) from public,anon,authenticated;
create function public.submit_application(p_name text,p_email text,p_message text default null) returns jsonb
language sql security definer set search_path=pg_catalog as $$select clinical_private.submit_application(p_name,p_email,p_message)$$;
revoke all on function public.submit_application(text,text,text) from public;
grant execute on function public.submit_application(text,text,text) to anon,authenticated;

-- Administrator read model.
create function clinical_private.patient_pipeline(org uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=clinical_private.live_actor(); n integer;
begin
 if not clinical_private.portal_assurance_sufficient() or not exists(
   select 1 from clinical_private.administrators where user_id=actor and organization_id=org and active
 ) then raise exception 'Administrator required' using errcode='42501';end if;
 delete from clinical_private.request_limits where actor_id=actor and bucket<date_trunc('minute',now())-interval '1 minute';
 insert into clinical_private.request_limits values(actor,date_trunc('minute',now()),1)
 on conflict(actor_id,bucket) do update set requests=clinical_private.request_limits.requests+1 returning requests into n;
 if n>120 then raise exception 'Request limit' using errcode='42501';end if;
 return jsonb_build_object(
  'registered',(select count(*) from clinical_private.organization_patients where organization_id=org and active),
  'signupTotal',(select count(*) from clinical_private.patient_signups where status='pending'),
  'signups',coalesce((select jsonb_agg(to_jsonb(x)) from(select id,display_name,identity_label,created_at,revision from clinical_private.patient_signups where status='pending' order by created_at,id limit 100)x),'[]'),
  'applicationTotal',(select count(*) from clinical_private.applications where status='new'),
  'applications',coalesce((select jsonb_agg(to_jsonb(x)) from(select id,name,email,message,created_at,revision from clinical_private.applications where status='new' order by created_at,id limit 100)x),'[]'),
  'weeks',coalesce((select jsonb_agg(jsonb_build_object('week',w,'registered',r) order by w) from(
     select date_trunc('week',p.created_at)::date w,count(*) r from clinical_private.organization_patients op
     join clinical_private.patients p on p.id=op.patient_id where op.organization_id=org and p.created_at>now()-interval '12 weeks' group by 1)q),'[]'));
end $$;

-- Administrator decisions: approve or reject a signup; mark an application handled or dismissed.
create function clinical_private.decide_pipeline(org uuid,kind text,item uuid,decision text,expected integer,attested boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=clinical_private.live_actor(); n integer; s clinical_private.patient_signups; pid uuid;
begin
 if not clinical_private.portal_assurance_sufficient() or not exists(
   select 1 from clinical_private.administrators where user_id=actor and organization_id=org and active
 ) then raise exception 'Administrator required' using errcode='42501';end if;
 delete from clinical_private.request_limits where actor_id=actor and bucket<date_trunc('minute',now())-interval '1 minute';
 insert into clinical_private.request_limits values(actor,date_trunc('minute',now()),1)
 on conflict(actor_id,bucket) do update set requests=clinical_private.request_limits.requests+1 returning requests into n;
 if n>120 then raise exception 'Request limit' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('admin:'||org::text,0));
 if kind='signup' then
  if decision not in ('approve','reject') then raise exception 'Invalid decision' using errcode='22023';end if;
  select * into s from clinical_private.patient_signups where id=item and status='pending' and revision=expected for update;
  if not found then raise exception 'Revision conflict' using errcode='40001';end if;
  if decision='approve' then
   if coalesce(attested,false)=false then raise exception 'Verified identity required' using errcode='22023';end if;
   if not exists(select 1 from auth.users where id=s.account_id and email_confirmed_at is not null and (banned_until is null or banned_until<now()))
    or exists(select 1 from clinical_private.patients where account_id=s.account_id or identity_label=btrim(s.identity_label))
   then raise exception 'Patient account unavailable' using errcode='22023';end if;
   insert into clinical_private.patients(account_id,display_name,identity_label,identity_verified)
   values(s.account_id,btrim(s.display_name),btrim(s.identity_label),true) returning id into pid;
   insert into clinical_private.organization_patients(organization_id,patient_id,verified_by,verified_at) values(org,pid,actor,now());
  end if;
  update clinical_private.patient_signups set status=case when decision='approve' then 'approved' else 'rejected' end,
   decided_at=now(),decided_by=actor,revision=revision+1 where id=item;
  insert into clinical_private.administration_audit(organization_id,actor_id,action,subject_id)
  values(org,actor,'administration.signup'||decision,coalesce(pid,item));
 elsif kind='application' then
  if decision not in ('handled','dismissed') then raise exception 'Invalid decision' using errcode='22023';end if;
  update clinical_private.applications set status=decision,handled_at=now(),handled_by=actor,revision=revision+1
  where id=item and status='new' and revision=expected;
  get diagnostics n=row_count;
  if n<>1 then raise exception 'Revision conflict' using errcode='40001';end if;
  insert into clinical_private.administration_audit(organization_id,actor_id,action,subject_id)
  values(org,actor,'administration.application'||decision,item);
 else raise exception 'Invalid decision' using errcode='22023';end if;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function clinical_private.patient_pipeline(uuid),clinical_private.decide_pipeline(uuid,text,uuid,text,integer,boolean) from public,anon,authenticated;
grant execute on function clinical_private.patient_pipeline(uuid),clinical_private.decide_pipeline(uuid,text,uuid,text,integer,boolean) to authenticated;
create function public.clinician_patient_pipeline(p_organization_id uuid) returns jsonb
language sql security invoker set search_path=pg_catalog as $$select clinical_private.patient_pipeline(p_organization_id)$$;
create function public.clinician_decide_pipeline(p_organization_id uuid,p_kind text,p_id uuid,p_decision text,p_revision integer,p_attested boolean default false) returns jsonb
language sql security invoker set search_path=pg_catalog as $$select clinical_private.decide_pipeline(p_organization_id,p_kind,p_id,p_decision,p_revision,p_attested)$$;
revoke all on function public.clinician_patient_pipeline(uuid),public.clinician_decide_pipeline(uuid,text,uuid,text,integer,boolean) from public,anon;
grant execute on function public.clinician_patient_pipeline(uuid),public.clinician_decide_pipeline(uuid,text,uuid,text,integer,boolean) to authenticated;
