-- Open chats check for news every few seconds. The check returns no patient data and is not audited;
-- the conversation itself is only fetched (and audited) when something has changed.
create or replace function clinical_private.patient_messaging(p_action text, args jsonb) returns jsonb
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
  -- A cheap change marker for an open chat: counts and times only, no message content, so it is not a journal read.
  if p_action = 'poll' then
    return (select jsonb_build_object('marker', concat_ws('|', count(*), max(created_at), max(read_at), max(handled_at)))
      from clinical_private.patient_messages where patient_id = pid and organization_id = org);
  end if;
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
