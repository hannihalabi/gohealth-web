-- The patient's tabs show how many messages the conversation has. The unaudited change check also returns the counts.
create or replace function clinical_private.patient_messaging(p_action text, args jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor(); pid uuid; org uuid; author text; t timestamptz; vt text; req clinical_private.booking_requests;
begin
  if not clinical_private.portal_assurance_sufficient()
    or not exists (select 1 from clinical_private.staff where user_id = actor and active)
  then raise exception 'Staff authentication required' using errcode = '42501'; end if;
  perform clinical_private.take_request(actor);
  pid := (args->>'patient')::uuid;
  org := clinical_private.care_organization(actor, pid);
  if org is null then raise exception 'Active care relation required' using errcode = '42501'; end if;
  -- A cheap change marker for an open chat, and the counts for the patient's tab: no message content, so it is not a journal read.
  if p_action = 'poll' then
    return (select jsonb_build_object('marker', concat_ws('|', count(*), max(created_at), max(read_at), max(handled_at), max(archived_at),
        (select max(coalesce(b.closed_at, b.booked_at, b.created_at)) from clinical_private.booking_requests b
          where b.patient_id = pid and b.organization_id = org)),
        'count', count(*), 'waiting', count(*) filter (where sender = 'patient' and handled_at is null))
      from clinical_private.patient_messages where patient_id = pid and organization_id = org);
  end if;
  if p_action in ('send', 'book') then
    if not exists (select 1 from clinical_private.patients where id = pid and identity_verified and account_id is not null)
    then raise exception 'Patient app account required' using errcode = '22023'; end if;
    select s.display_name into author from clinical_private.staff s where s.user_id = actor and s.organization_id = org;
  end if;
  if p_action = 'send' then
    if length(btrim(coalesce(args->>'body', ''))) not between 1 and 4000 then raise exception 'Message required' using errcode = '22023'; end if;
    update clinical_private.patient_messages set handled_at = now(), handled_by = actor
    where patient_id = pid and organization_id = org and sender = 'patient' and handled_at is null;
    insert into clinical_private.patient_messages (organization_id, patient_id, sender, author_id, author_name, body)
    values (org, pid, 'clinician', actor, author, btrim(args->>'body'));
    insert into clinical_private.audit (actor_id, patient_id, action) values (actor, pid, 'messages.send');
  elsif p_action = 'book' then
    -- Ask the patient to book one of my own free times.
    vt := args->>'visit_type';
    if vt is null or vt not in ('video', 'phone', 'clinic') or length(coalesce(args->>'body', '')) > 4000
    then raise exception 'Invalid booking request' using errcode = '22023'; end if;
    if not exists (select 1 from clinical_private.availability_slots s where s.clinician_id = actor and s.organization_id = org
      and s.starts_at > now() + interval '15 minutes' and clinical_private.free_slot(s))
    then raise exception 'No free times' using errcode = '22023'; end if;
    -- Only the newest request in a conversation can be booked.
    update clinical_private.booking_requests set status = 'withdrawn', closed_at = now(), closed_by = actor
    where patient_id = pid and organization_id = org and status = 'open';
    insert into clinical_private.booking_requests (organization_id, patient_id, clinician_id, visit_type)
    values (org, pid, actor, vt) returning * into req;
    update clinical_private.patient_messages set handled_at = now(), handled_by = actor
    where patient_id = pid and organization_id = org and sender = 'patient' and handled_at is null;
    insert into clinical_private.patient_messages (organization_id, patient_id, sender, author_id, author_name, body, kind, booking_id)
    values (org, pid, 'clinician', actor, author,
      coalesce(nullif(btrim(args->>'body'), ''), 'Välj en tid för ' || lower(clinical_private.visit_name(vt)) || ' nedan.'), 'booking', req.id);
    insert into clinical_private.audit (actor_id, patient_id, action) values (actor, pid, 'booking.request');
  elsif p_action = 'unbook' then
    -- Withdraw a request, or cancel a booked time; the patient is told in the chat.
    select * into req from clinical_private.booking_requests where id = (args->>'booking')::uuid and patient_id = pid and organization_id = org for update;
    if req.id is null or req.status = 'withdrawn' then raise exception 'Booking unavailable' using errcode = '22023'; end if;
    update clinical_private.booking_requests set status = 'withdrawn', slot_id = null, closed_at = now(), closed_by = actor where id = req.id;
    select s.display_name into author from clinical_private.staff s where s.user_id = actor and s.organization_id = org;
    insert into clinical_private.patient_messages (organization_id, patient_id, sender, author_id, author_name, body, kind, booking_id)
    values (org, pid, 'clinician', actor, author,
      case when req.status = 'booked' then 'Din tid ' || clinical_private.sv_time(req.starts_at) || ' är avbokad.' else 'Bokningsförfrågan är återkallad.' end,
      'unbooked', req.id);
    insert into clinical_private.audit (actor_id, patient_id, action) values (actor, pid, 'booking.cancel');
  elsif p_action = 'archive' then
    -- Close the conversation: it leaves the patient's app, waiting messages count as handled and open requests lapse.
    if not exists (select 1 from clinical_private.patient_messages where patient_id = pid and organization_id = org and archived_at is null)
    then raise exception 'Nothing to archive' using errcode = '22023'; end if;
    t := clock_timestamp();
    update clinical_private.patient_messages set handled_at = t, handled_by = actor
    where patient_id = pid and organization_id = org and sender = 'patient' and handled_at is null;
    update clinical_private.booking_requests set status = 'withdrawn', closed_at = t, closed_by = actor
    where patient_id = pid and organization_id = org and status = 'open';
    update clinical_private.patient_messages set archived_at = t, archived_by = actor
    where patient_id = pid and organization_id = org and archived_at is null;
    insert into clinical_private.audit (actor_id, patient_id, action) values (actor, pid, 'messages.archive');
  elsif p_action = 'resolve' then
    update clinical_private.patient_messages set handled_at = now(), handled_by = actor
    where patient_id = pid and organization_id = org and sender = 'patient' and handled_at is null;
    insert into clinical_private.audit (actor_id, patient_id, action) values (actor, pid, 'messages.resolve');
  elsif p_action = 'thread' then
    insert into clinical_private.audit (actor_id, patient_id, action) values (actor, pid, 'messages.read');
  else raise exception 'Invalid action' using errcode = '22023';
  end if;
  return clinical_private.message_thread(pid, org, actor);
end $$;
