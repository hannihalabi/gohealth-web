-- Chat: close (archive) a conversation, quick replies, and booking requests against the clinician's own free times.
-- An archived conversation disappears from the patient's app but stays with the care team. Every step is audited.

alter table clinical_private.patient_messages
  add column kind text not null default 'text' check (kind in ('text', 'booking', 'booked', 'unbooked')),
  add column booking_id uuid,
  add column archived_at timestamptz,
  add column archived_by uuid references auth.users(id) on delete set null;
create index patient_messages_live on clinical_private.patient_messages(patient_id, created_at) where archived_at is null;

-- Free times a clinician offers. A time is booked when a booking request holds it.
create table clinical_private.availability_slots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_private.organizations,
  clinician_id uuid not null references auth.users(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at - starts_at <= interval '4 hours')
);
create index availability_slots_clinician on clinical_private.availability_slots(clinician_id, starts_at);

-- "Boka tid" in the chat: the patient picks one of the clinician's free times. The booked time is copied so it
-- stays in the history even if the free time is later removed.
create table clinical_private.booking_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_private.organizations,
  patient_id uuid not null references clinical_private.patients,
  clinician_id uuid not null,
  visit_type text not null check (visit_type in ('video', 'phone', 'clinic')),
  status text not null default 'open' check (status in ('open', 'booked', 'withdrawn')),
  slot_id uuid references clinical_private.availability_slots on delete set null,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  booked_at timestamptz,
  closed_at timestamptz,
  closed_by uuid references auth.users(id) on delete set null,
  check (status <> 'booked' or starts_at is not null)
);
-- One booking per free time, also under concurrent bookings.
create unique index booking_requests_slot on clinical_private.booking_requests(slot_id) where status = 'booked';
create index booking_requests_patient on clinical_private.booking_requests(patient_id, status);
create index booking_requests_clinician on clinical_private.booking_requests(clinician_id, starts_at) where status = 'booked';

-- Each clinician's own quick replies; the built-in ones live in the portal.
create table clinical_private.quick_replies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index quick_replies_user on clinical_private.quick_replies(user_id, created_at);

alter table clinical_private.availability_slots enable row level security;
alter table clinical_private.booking_requests enable row level security;
alter table clinical_private.quick_replies enable row level security;
revoke all on clinical_private.availability_slots, clinical_private.booking_requests, clinical_private.quick_replies from public, anon, authenticated;

-- Helpers, only called from the functions below.
create function clinical_private.take_request(actor uuid) returns void
language plpgsql set search_path = pg_catalog as $$
declare n integer;
begin
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
end $$;
create function clinical_private.iso_utc(t timestamptz) returns text
language sql immutable set search_path = pg_catalog as $$select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')$$;
-- Swedish wording for message text, e.g. "tis 25 nov 09:20".
create function clinical_private.sv_time(t timestamptz) returns text
language sql stable set search_path = pg_catalog as $$
  select (array['sön','mån','tis','ons','tor','fre','lör'])[extract(dow from l)::int + 1] || ' ' || extract(day from l)::int || ' '
    || (array['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'])[extract(month from l)::int] || ' ' || to_char(l, 'HH24:MI')
  from (select t at time zone 'Europe/Stockholm' as l) x $$;
create function clinical_private.visit_name(visit_type text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case visit_type when 'video' then 'Videosamtal' when 'phone' then 'Telefonsamtal' else 'Besök på mottagningen' end $$;
create function clinical_private.booking_json(b clinical_private.booking_requests) returns jsonb
language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object('id', b.id, 'status', b.status, 'visit_type', b.visit_type,
    'starts_at', clinical_private.iso_utc(b.starts_at), 'ends_at', clinical_private.iso_utc(b.ends_at),
    'clinician_name', (select s.display_name from clinical_private.staff s where s.user_id = b.clinician_id and s.organization_id = b.organization_id),
    'can_unbook', b.status = 'booked' and b.starts_at > now()) $$;
create function clinical_private.free_slot(s clinical_private.availability_slots) returns boolean
language sql stable set search_path = pg_catalog as $$
  select not exists (select 1 from clinical_private.booking_requests b where b.slot_id = s.id and b.status = 'booked') $$;

-- The conversation as the care team sees it: archived conversations included.
create function clinical_private.message_thread(pid uuid, org uuid, actor uuid) returns jsonb
language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object(
    'can_message', exists (select 1 from clinical_private.patients where id = pid and identity_verified and account_id is not null),
    'free_times', (select count(*) from clinical_private.availability_slots s
      where s.clinician_id = actor and s.organization_id = org and s.starts_at > now() and clinical_private.free_slot(s)),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'sender', m.sender, 'kind', m.kind, 'author_name', m.author_name,
        'body', m.body, 'created_at', m.created_at, 'read_at', m.read_at, 'handled_at', m.handled_at, 'archived_at', m.archived_at,
        'booking', case when b.id is null then null else clinical_private.booking_json(b) end) order by m.created_at, m.id)
      from (select * from clinical_private.patient_messages where patient_id = pid and organization_id = org
            order by created_at desc, id desc limit 500) m
      left join clinical_private.booking_requests b on b.id = m.booking_id and m.kind = 'booking'), '[]'::jsonb)) $$;

-- The conversation as the patient sees it: archived conversations are gone; booked times stay visible.
create function clinical_private.patient_thread(pid uuid) returns jsonb
language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object(
    'can_reply', exists (select 1 from clinical_private.patient_messages where patient_id = pid and sender = 'clinician' and archived_at is null),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'sender', m.sender, 'kind', m.kind, 'author_name', m.author_name,
        'body', m.body, 'created_at', clinical_private.iso_utc(m.created_at), 'read_at', clinical_private.iso_utc(m.read_at),
        'booking', case when b.id is null then null else clinical_private.booking_json(b) end) order by m.created_at, m.id)
      from (select * from clinical_private.patient_messages where patient_id = pid and archived_at is null
            order by created_at desc, id desc limit 500) m
      left join clinical_private.booking_requests b on b.id = m.booking_id and m.kind = 'booking'), '[]'::jsonb),
    'upcoming', coalesce((select jsonb_agg(clinical_private.booking_json(b) order by b.starts_at)
      from clinical_private.booking_requests b where b.patient_id = pid and b.status = 'booked' and b.ends_at > now()), '[]'::jsonb)) $$;

revoke all on function clinical_private.take_request(uuid), clinical_private.iso_utc(timestamptz), clinical_private.sv_time(timestamptz),
  clinical_private.visit_name(text), clinical_private.booking_json(clinical_private.booking_requests),
  clinical_private.free_slot(clinical_private.availability_slots), clinical_private.message_thread(uuid, uuid, uuid),
  clinical_private.patient_thread(uuid) from public, anon, authenticated;

-- Care team side.
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
  -- A cheap change marker for an open chat: counts and times only, no message content, so it is not a journal read.
  if p_action = 'poll' then
    return (select jsonb_build_object('marker', concat_ws('|', count(*), max(created_at), max(read_at), max(handled_at), max(archived_at),
        (select max(coalesce(b.closed_at, b.booked_at, b.created_at)) from clinical_private.booking_requests b
          where b.patient_id = pid and b.organization_id = org)))
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

-- Patient side (app).
create or replace function clinical_private.patient_inbox(p_action text, args jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor(); pat clinical_private.patients; org uuid;
  req clinical_private.booking_requests; slot clinical_private.availability_slots;
begin
  select * into pat from clinical_private.patients where account_id = actor and identity_verified;
  if pat.id is null then raise exception 'Verified patient account required' using errcode = '42501'; end if;
  perform clinical_private.take_request(actor);
  if p_action in ('slots', 'book', 'unbook') then
    select * into req from clinical_private.booking_requests where id = (args->>'booking')::uuid and patient_id = pat.id for update;
    if req.id is null then raise exception 'Booking unavailable' using errcode = '22023'; end if;
  end if;
  if p_action in ('slots', 'book') and (req.status <> 'open' or not exists (select 1 from clinical_private.patient_messages
      where booking_id = req.id and kind = 'booking' and archived_at is null))
  then raise exception 'Booking unavailable' using errcode = '22023'; end if;

  if p_action = 'slots' then
    return jsonb_build_object('slots', coalesce((select jsonb_agg(jsonb_build_object('id', s.id,
        'starts_at', clinical_private.iso_utc(s.starts_at), 'ends_at', clinical_private.iso_utc(s.ends_at)) order by s.starts_at)
      from (select * from clinical_private.availability_slots s where s.clinician_id = req.clinician_id and s.organization_id = req.organization_id
            and s.starts_at > now() + interval '15 minutes' and s.starts_at < now() + interval '120 days' and clinical_private.free_slot(s)
            order by s.starts_at limit 200) s), '[]'::jsonb));
  elsif p_action = 'book' then
    select * into slot from clinical_private.availability_slots where id = (args->>'slot')::uuid and clinician_id = req.clinician_id
      and organization_id = req.organization_id and starts_at > now() + interval '15 minutes' for update;
    if slot.id is null or not clinical_private.free_slot(slot) then raise exception 'Time unavailable' using errcode = '22023'; end if;
    begin
      update clinical_private.booking_requests set status = 'booked', slot_id = slot.id, starts_at = slot.starts_at, ends_at = slot.ends_at, booked_at = now()
      where id = req.id;
    exception when unique_violation then raise exception 'Time unavailable' using errcode = '22023';
    end;
    insert into clinical_private.patient_messages (organization_id, patient_id, sender, author_id, author_name, body, kind, booking_id, handled_at)
    values (req.organization_id, pat.id, 'patient', actor, pat.display_name,
      'Bokade ' || clinical_private.sv_time(slot.starts_at) || '–' || to_char(slot.ends_at at time zone 'Europe/Stockholm', 'HH24:MI')
        || ' · ' || clinical_private.visit_name(req.visit_type), 'booked', req.id, now());
    insert into clinical_private.audit (actor_id, patient_id, action) values (actor, pat.id, 'booking.book');
  elsif p_action = 'unbook' then
    -- The patient cancels a booked time before it starts. The request opens again only while its conversation is open.
    if req.status <> 'booked' or req.starts_at <= now() then raise exception 'Booking unavailable' using errcode = '22023'; end if;
    update clinical_private.booking_requests set
      status = case when exists (select 1 from clinical_private.patient_messages where booking_id = req.id and kind = 'booking' and archived_at is null)
        then 'open' else 'withdrawn' end,
      slot_id = null, starts_at = null, ends_at = null, booked_at = null, closed_at = now(), closed_by = actor
    where id = req.id;
    -- Waits for the care team, so the cancellation is noticed.
    insert into clinical_private.patient_messages (organization_id, patient_id, sender, author_id, author_name, body, kind, booking_id)
    values (req.organization_id, pat.id, 'patient', actor, pat.display_name,
      'Avbokade ' || clinical_private.sv_time(req.starts_at) || ' · ' || clinical_private.visit_name(req.visit_type), 'unbooked', req.id);
    insert into clinical_private.audit (actor_id, patient_id, action) values (actor, pat.id, 'booking.unbook');
  elsif p_action = 'send' then
    if length(btrim(coalesce(args->>'body', ''))) not between 1 and 4000 then raise exception 'Message required' using errcode = '22023'; end if;
    select organization_id into org from clinical_private.patient_messages
    where patient_id = pat.id and sender = 'clinician' and archived_at is null order by created_at desc limit 1;
    if org is null then raise exception 'No conversation' using errcode = '22023'; end if;
    insert into clinical_private.patient_messages (organization_id, patient_id, sender, author_id, author_name, body)
    values (org, pat.id, 'patient', actor, pat.display_name, btrim(args->>'body'));
    insert into clinical_private.audit (actor_id, patient_id, action) values (actor, pat.id, 'messages.patient_send');
  elsif p_action = 'read' then
    update clinical_private.patient_messages set read_at = now()
    where patient_id = pat.id and sender = 'clinician' and read_at is null and archived_at is null;
  elsif p_action is distinct from 'list' then raise exception 'Invalid action' using errcode = '22023';
  end if;
  return clinical_private.patient_thread(pat.id);
end $$;

create function public.gohealth_booking_slots(p_booking uuid) returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.patient_inbox('slots', jsonb_build_object('booking', p_booking))$$;
create function public.gohealth_book_time(p_booking uuid, p_slot uuid) returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.patient_inbox('book', jsonb_build_object('booking', p_booking, 'slot', p_slot))$$;
create function public.gohealth_unbook_time(p_booking uuid) returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.patient_inbox('unbook', jsonb_build_object('booking', p_booking))$$;
revoke all on function public.gohealth_booking_slots(uuid), public.gohealth_book_time(uuid, uuid), public.gohealth_unbook_time(uuid) from public, anon;
grant execute on function public.gohealth_booking_slots(uuid), public.gohealth_book_time(uuid, uuid), public.gohealth_unbook_time(uuid) to authenticated;

-- "Min kalender": the clinician's own free and booked times.
create function clinical_private.clinician_calendar(p_action text, args jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor(); org uuid; day date; first_start timestamptz; last_end timestamptz;
  minutes integer; added integer := 0; window_start timestamptz; window_days integer;
begin
  if not clinical_private.portal_assurance_sufficient()
    or not exists (select 1 from clinical_private.staff where user_id = actor and active)
  then raise exception 'Staff authentication required' using errcode = '42501'; end if;
  perform clinical_private.take_request(actor);
  if p_action = 'add' then
    -- A block such as 09:00–12:00 on one day, split into times of equal length; overlaps with existing times are skipped.
    select organization_id into org from clinical_private.staff where user_id = actor and active
    order by (organization_id::text = args->>'organization') desc, organization_id limit 1;
    day := (args->>'date')::date;
    minutes := (args->>'minutes')::int;
    first_start := (day + (args->>'from')::time) at time zone 'Europe/Stockholm';
    last_end := (day + (args->>'to')::time) at time zone 'Europe/Stockholm';
    if minutes is null or minutes not between 5 and 240 or last_end <= first_start or first_start < now()
      or first_start > now() + interval '365 days' or extract(epoch from last_end - first_start) / 60 / minutes > 96
    then raise exception 'Invalid time block' using errcode = '22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended('availability:' || actor::text, 0));
    insert into clinical_private.availability_slots (organization_id, clinician_id, starts_at, ends_at)
    select org, actor, g, g + minutes * interval '1 minute'
    from generate_series(first_start, last_end - minutes * interval '1 minute', minutes * interval '1 minute') g
    where not exists (select 1 from clinical_private.availability_slots s where s.clinician_id = actor
      and s.starts_at < g + minutes * interval '1 minute' and s.ends_at > g);
    get diagnostics added = row_count;
    return jsonb_build_object('added', added);
  elsif p_action = 'remove' then
    if exists (select 1 from clinical_private.availability_slots s where s.id = (args->>'slot')::uuid and s.clinician_id = actor
      and not clinical_private.free_slot(s)) then raise exception 'Time booked' using errcode = '22023'; end if;
    delete from clinical_private.availability_slots where id = (args->>'slot')::uuid and clinician_id = actor;
    if not found then raise exception 'Time unavailable' using errcode = '22023'; end if;
    return jsonb_build_object('removed', 1);
  elsif p_action = 'list' then
    window_start := (coalesce((args->>'from')::date, (now() at time zone 'Europe/Stockholm')::date)::timestamp) at time zone 'Europe/Stockholm';
    window_days := coalesce((args->>'days')::int, 7);
    if window_days not between 1 and 42 then raise exception 'Invalid window' using errcode = '22023'; end if;
    insert into clinical_private.audit (actor_id, action) values (actor, 'calendar.read');
    return jsonb_build_object(
      'times', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
          'booking', case when b.id is null then null else jsonb_build_object('id', b.id, 'patient_id', b.patient_id,
            'patient', p.display_name, 'visit_type', b.visit_type) end) order by s.starts_at)
        from clinical_private.availability_slots s
        left join clinical_private.booking_requests b on b.slot_id = s.id and b.status = 'booked'
        left join clinical_private.patients p on p.id = b.patient_id
        where s.clinician_id = actor and s.starts_at >= window_start and s.starts_at < window_start + window_days * interval '1 day'), '[]'::jsonb),
      'upcoming', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'patient_id', b.patient_id, 'patient', p.display_name,
          'visit_type', b.visit_type, 'starts_at', b.starts_at, 'ends_at', b.ends_at) order by b.starts_at)
        from (select * from clinical_private.booking_requests where clinician_id = actor and status = 'booked' and ends_at > now()
              order by starts_at limit 20) b
        join clinical_private.patients p on p.id = b.patient_id), '[]'::jsonb));
  end if;
  raise exception 'Invalid action' using errcode = '22023';
end $$;
revoke all on function clinical_private.clinician_calendar(text, jsonb) from public, anon, authenticated;
grant execute on function clinical_private.clinician_calendar(text, jsonb) to authenticated;
create function public.clinician_calendar(p_action text, p_args jsonb default '{}') returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.clinician_calendar(p_action, p_args)$$;
revoke all on function public.clinician_calendar(text, jsonb) from public, anon;
grant execute on function public.clinician_calendar(text, jsonb) to authenticated;

-- Quick replies: each clinician's own.
create function clinical_private.quick_reply(p_action text, args jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor();
begin
  if not clinical_private.portal_assurance_sufficient()
    or not exists (select 1 from clinical_private.staff where user_id = actor and active)
  then raise exception 'Staff authentication required' using errcode = '42501'; end if;
  perform clinical_private.take_request(actor);
  if p_action = 'add' then
    if length(btrim(coalesce(args->>'body', ''))) not between 1 and 1000 then raise exception 'Reply required' using errcode = '22023'; end if;
    if (select count(*) from clinical_private.quick_replies where user_id = actor) >= 50 then raise exception 'Too many quick replies' using errcode = '22023'; end if;
    insert into clinical_private.quick_replies (user_id, body) values (actor, btrim(args->>'body'));
  elsif p_action = 'remove' then
    delete from clinical_private.quick_replies where id = (args->>'id')::uuid and user_id = actor;
  elsif p_action is distinct from 'list' then raise exception 'Invalid action' using errcode = '22023';
  end if;
  return jsonb_build_object('replies', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'body', q.body) order by q.created_at, q.id)
    from clinical_private.quick_replies q where q.user_id = actor), '[]'::jsonb));
end $$;
revoke all on function clinical_private.quick_reply(text, jsonb) from public, anon, authenticated;
grant execute on function clinical_private.quick_reply(text, jsonb) to authenticated;
create function public.clinician_quick_replies(p_action text, p_args jsonb default '{}') returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.quick_reply(p_action, p_args)$$;
revoke all on function public.clinician_quick_replies(text, jsonb) from public, anon;
grant execute on function public.clinician_quick_replies(text, jsonb) to authenticated;

-- Inbox: archived conversations are listed apart; the marker moves when a conversation is closed.
create or replace function clinical_private.message_inbox(p_action text) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor(); result jsonb;
begin
  if not clinical_private.portal_assurance_sufficient()
    or not exists (select 1 from clinical_private.staff where user_id = actor and active)
  then raise exception 'Staff authentication required' using errcode = '42501'; end if;
  if p_action is null or p_action not in ('list', 'poll') then raise exception 'Invalid action' using errcode = '22023'; end if;
  perform clinical_private.take_request(actor);
  with conv as (
    select m.patient_id, m.organization_id,
      count(*) filter (where m.sender = 'patient' and m.handled_at is null) as waiting,
      max(m.created_at) as last_at, bool_and(m.archived_at is not null) as archived, max(m.archived_at) as archived_at
    from clinical_private.patient_messages m
    join clinical_private.staff me on me.user_id = actor and me.active and me.organization_id = m.organization_id
    group by m.patient_id, m.organization_id
  ), visible as (
    select c.*, p.display_name, p.identity_label,
      (exists (select 1 from clinical_private.assignments a where a.patient_id = c.patient_id and a.organization_id = c.organization_id
                and a.clinician_id = actor and a.active)
        or exists (select 1 from clinical_private.patient_messages x where x.patient_id = c.patient_id
                and x.organization_id = c.organization_id and x.author_id = actor)) as mine
    from conv c join clinical_private.patients p on p.id = c.patient_id
    where clinical_private.care_organization(actor, c.patient_id) = c.organization_id
  )
  select case when p_action = 'poll' then
      jsonb_build_object('marker', concat_ws('|', count(*), max(last_at), sum(waiting), max(archived_at)),
        'waiting', count(*) filter (where mine and waiting > 0))
    else jsonb_build_object('waiting', count(*) filter (where mine and waiting > 0),
      'conversations', coalesce(jsonb_agg(jsonb_build_object('patient_id', v.patient_id, 'display_name', v.display_name,
          'identity_label', v.identity_label, 'mine', v.mine, 'waiting', v.waiting, 'last_at', v.last_at,
          'archived', v.archived, 'archived_at', v.archived_at, 'last_sender', l.sender, 'last_kind', l.kind, 'last_body', l.body)
        order by (v.waiting > 0) desc, v.last_at desc), '[]'::jsonb))
    end into result
  from visible v
  left join lateral (select x.sender, x.kind, left(x.body, 200) as body from clinical_private.patient_messages x
    where x.patient_id = v.patient_id and x.organization_id = v.organization_id order by x.created_at desc, x.id desc limit 1) l on true;
  if p_action = 'list' then insert into clinical_private.audit (actor_id, action) values (actor, 'messages.inbox'); end if;
  return result;
end $$;
