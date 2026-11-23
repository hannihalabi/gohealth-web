-- Messages between the care team and the patient. A clinician starts the conversation; the patient can reply in the app.
-- Patient messages wait for the care team until a clinician answers or marks them handled. Every step is audited.
create table clinical_private.patient_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_private.organizations,
  patient_id uuid not null references clinical_private.patients,
  sender text not null check (sender in ('clinician', 'patient')),
  author_id uuid references auth.users(id) on delete set null,
  author_name text not null check (length(btrim(author_name)) between 1 and 160),
  body text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  handled_at timestamptz,
  handled_by uuid references auth.users(id) on delete set null,
  check (sender = 'clinician' or read_at is null),
  check (sender = 'patient' or handled_at is null)
);
create index patient_messages_thread on clinical_private.patient_messages(patient_id, organization_id, created_at);
create index patient_messages_waiting on clinical_private.patient_messages(organization_id, created_at desc) where sender = 'patient' and handled_at is null;
alter table clinical_private.patient_messages enable row level security;
revoke all on clinical_private.patient_messages from public, anon, authenticated;

-- Care team side: read the thread, write to the patient, or mark the patient's messages handled.
create function clinical_private.patient_messaging(p_action text, args jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor(); n integer; pid uuid; org uuid; author text;
begin
  if not clinical_private.portal_assurance_sufficient()
    or not exists (select 1 from clinical_private.staff where user_id = actor and active)
  then raise exception 'Staff authentication required' using errcode = '42501'; end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  pid := (args->>'patient')::uuid;
  org := clinical_private.care_organization(actor, pid);
  if org is null then raise exception 'Active care relation required' using errcode = '42501'; end if;
  if p_action = 'send' then
    if length(btrim(coalesce(args->>'body', ''))) not between 1 and 4000 then raise exception 'Message required' using errcode = '22023'; end if;
    if not exists (select 1 from clinical_private.patients where id = pid and identity_verified and account_id is not null)
    then raise exception 'Patient app account required' using errcode = '22023'; end if;
    select s.display_name into author from clinical_private.staff s where s.user_id = actor and s.organization_id = org;
    update clinical_private.patient_messages set handled_at = now(), handled_by = actor
    where patient_id = pid and organization_id = org and sender = 'patient' and handled_at is null;
    insert into clinical_private.patient_messages (organization_id, patient_id, sender, author_id, author_name, body)
    values (org, pid, 'clinician', actor, author, btrim(args->>'body'));
    insert into clinical_private.audit (actor_id, patient_id, action) values (actor, pid, 'messages.send');
  elsif p_action = 'resolve' then
    update clinical_private.patient_messages set handled_at = now(), handled_by = actor
    where patient_id = pid and organization_id = org and sender = 'patient' and handled_at is null;
    insert into clinical_private.audit (actor_id, patient_id, action) values (actor, pid, 'messages.resolve');
  elsif p_action = 'thread' then
    insert into clinical_private.audit (actor_id, patient_id, action) values (actor, pid, 'messages.read');
  else raise exception 'Invalid action' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'can_message', exists (select 1 from clinical_private.patients where id = pid and identity_verified and account_id is not null),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'sender', m.sender, 'author_name', m.author_name, 'body', m.body,
        'created_at', m.created_at, 'read_at', m.read_at, 'handled_at', m.handled_at) order by m.created_at, m.id)
      from (select * from clinical_private.patient_messages where patient_id = pid and organization_id = org
            order by created_at desc, id desc limit 500) m), '[]'::jsonb));
end $$;
revoke all on function clinical_private.patient_messaging(text, jsonb) from public, anon, authenticated;
grant execute on function clinical_private.patient_messaging(text, jsonb) to authenticated;
create function public.clinician_patient_messages(p_action text, p_args jsonb) returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.patient_messaging(p_action, p_args)$$;
revoke all on function public.clinician_patient_messages(text, jsonb) from public, anon;
grant execute on function public.clinician_patient_messages(text, jsonb) to authenticated;

-- Patient side (app): read the conversation, mark it read, and reply once the care team has written.
create function clinical_private.patient_inbox(p_action text, args jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor(); n integer; pat clinical_private.patients; org uuid;
begin
  select * into pat from clinical_private.patients where account_id = actor and identity_verified;
  if pat.id is null then raise exception 'Verified patient account required' using errcode = '42501'; end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  if p_action = 'send' then
    if length(btrim(coalesce(args->>'body', ''))) not between 1 and 4000 then raise exception 'Message required' using errcode = '22023'; end if;
    select organization_id into org from clinical_private.patient_messages
    where patient_id = pat.id and sender = 'clinician' order by created_at desc limit 1;
    if org is null then raise exception 'No conversation' using errcode = '22023'; end if;
    insert into clinical_private.patient_messages (organization_id, patient_id, sender, author_id, author_name, body)
    values (org, pat.id, 'patient', actor, pat.display_name, btrim(args->>'body'));
    insert into clinical_private.audit (actor_id, patient_id, action) values (actor, pat.id, 'messages.patient_send');
  elsif p_action = 'read' then
    update clinical_private.patient_messages set read_at = now() where patient_id = pat.id and sender = 'clinician' and read_at is null;
  elsif p_action is distinct from 'list' then raise exception 'Invalid action' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'can_reply', exists (select 1 from clinical_private.patient_messages where patient_id = pat.id and sender = 'clinician'),
    -- Times as UTC with milliseconds, which every ISO 8601 parser in the app accepts.
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'sender', m.sender, 'author_name', m.author_name, 'body', m.body,
        'created_at', to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'read_at', to_char(m.read_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by m.created_at, m.id)
      from (select * from clinical_private.patient_messages where patient_id = pat.id order by created_at desc, id desc limit 500) m), '[]'::jsonb));
end $$;
revoke all on function clinical_private.patient_inbox(text, jsonb) from public, anon, authenticated;
grant execute on function clinical_private.patient_inbox(text, jsonb) to authenticated;
create function public.gohealth_messages() returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.patient_inbox('list', '{}'::jsonb)$$;
create function public.gohealth_send_message(p_body text) returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.patient_inbox('send', jsonb_build_object('body', p_body))$$;
create function public.gohealth_mark_messages_read() returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.patient_inbox('read', '{}'::jsonb)$$;
revoke all on function public.gohealth_messages(), public.gohealth_send_message(text), public.gohealth_mark_messages_read() from public, anon;
grant execute on function public.gohealth_messages(), public.gohealth_send_message(text), public.gohealth_mark_messages_read() to authenticated;

-- Start page: patient messages waiting for the care team.
create or replace function clinical_private.clinician_overview() returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor(); n integer; result jsonb;
begin
  if not clinical_private.portal_assurance_sufficient()
    or not exists (select 1 from clinical_private.staff where user_id = actor and active)
  then raise exception 'Staff authentication required' using errcode = '42501'; end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  with orgs as (select organization_id from clinical_private.staff where user_id = actor and active),
  -- Patient messages waiting for the care team: my own patients, and conversations I have written in.
  inbox as (
    select distinct on (m.patient_id, m.organization_id) m.patient_id, p.display_name, left(m.body, 240) as body, m.created_at,
      count(*) over (partition by m.patient_id, m.organization_id) as waiting
    from clinical_private.patient_messages m
    join orgs on orgs.organization_id = m.organization_id
    join clinical_private.patients p on p.id = m.patient_id
    where m.sender = 'patient' and m.handled_at is null
      and (exists (select 1 from clinical_private.assignments a where a.patient_id = m.patient_id and a.organization_id = m.organization_id
             and a.clinician_id = actor and a.active)
        or exists (select 1 from clinical_private.patient_messages x where x.patient_id = m.patient_id
             and x.organization_id = m.organization_id and x.author_id = actor))
    order by m.patient_id, m.organization_id, m.created_at desc
  ),
  drafts as (
    select r.id, r.patient_id, p.display_name, r.kind, r.payload->>'title' as title, r.created_at
    from clinical_private.records r
    join clinical_private.patients p on p.id = r.patient_id
    join orgs on orgs.organization_id = r.organization_id
    where r.status = 'draft' and r.superseded_at is null
      and (r.created_by = actor or exists (select 1 from clinical_private.assignments a
        where a.patient_id = r.patient_id and a.organization_id = r.organization_id and a.clinician_id = actor and a.active))
  )
  select jsonb_build_object(
    'counts', jsonb_build_object(
      'assigned', (select count(distinct a.patient_id) from clinical_private.assignments a
        join orgs on orgs.organization_id = a.organization_id
        join clinical_private.organization_patients op on op.patient_id = a.patient_id and op.organization_id = a.organization_id and op.active
        where a.clinician_id = actor and a.active),
      'clinic', (select count(distinct op.patient_id) from clinical_private.organization_patients op
        join orgs on orgs.organization_id = op.organization_id where op.active),
      'unsigned', (select count(*) from drafts),
      'consultations', (select count(*) from clinical_private.consultations c where c.to_user = actor and c.status = 'open'),
      'messages', (select count(*) from inbox)),
    'unsigned', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at desc) from (select * from drafts order by created_at desc limit 5) d), '[]'::jsonb),
    'announcements', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'created_at', a.created_at,
        'author', coalesce(ad.display_name, 'Administratör')) order by a.created_at desc)
      from (select sa.* from clinical_private.staff_announcements sa join orgs on orgs.organization_id = sa.organization_id
            where sa.archived_at is null and (sa.expires_at is null or sa.expires_at > now()) order by sa.created_at desc limit 10) a
      left join clinical_private.administrators ad on ad.user_id = a.created_by and ad.organization_id = a.organization_id), '[]'::jsonb),
    'consultations', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'patient_id', c.patient_id, 'display_name', p.display_name,
        'direction', case when c.to_user = actor then 'in' else 'out' end, 'status', c.status, 'message', c.message, 'reply', c.reply,
        'created_at', c.created_at, 'replied_at', c.replied_at,
        'from_name', (select s.display_name from clinical_private.staff s where s.user_id = c.from_user and s.organization_id = c.organization_id),
        'to_name', (select s.display_name from clinical_private.staff s where s.user_id = c.to_user and s.organization_id = c.organization_id),
        'record', (select jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.payload->>'title') from clinical_private.records r where r.id = c.record_id))
        order by (c.status = 'open' and c.to_user = actor) desc, coalesce(c.replied_at, c.created_at) desc)
      from (select * from clinical_private.consultations where (to_user = actor or from_user = actor) and status <> 'closed'
            order by created_at desc limit 30) c
      join clinical_private.patients p on p.id = c.patient_id), '[]'::jsonb),
    'deviations', clinical_private.patient_deviations(actor),
    'messages', coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at desc) from (select * from inbox order by created_at desc limit 20) i), '[]'::jsonb)
  ) into result;
  insert into clinical_private.audit (actor_id, action) values (actor, 'clinician.overview');
  return result;
end $$;
