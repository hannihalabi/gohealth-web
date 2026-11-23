-- Execute inside a transaction and roll back. Synthetic accounts only.
-- Users: 1 assigned doctor, 2 colleague doctor, 3 unassigned nurse, 4 doctor in another clinic, 5 patient, 6 second patient.
create function pg_temp.cb_assert(condition boolean, label text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'Failed: %', label; end if; end $$;
create function pg_temp.cb_denied(statement text, state text, label text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'Unexpected success: %', label;
exception when others then
  if sqlstate is distinct from state then raise; end if;
end $$;
create function pg_temp.cb_claims(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'f1000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'session_id', 'f2000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'aal', 'aal1', 'amr', jsonb_build_array(jsonb_build_object('method', 'password')))::text, true);
end $$;
update clinical_private.portal_settings set mfa_required = false;
insert into auth.users(id, email, email_confirmed_at)
select ('f1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'booking-' || n || '@example.invalid', now() from generate_series(1, 6) n;
insert into auth.sessions(id, user_id)
select ('f2000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ('f1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid from generate_series(1, 6) n;
insert into clinical_private.organizations(id, name) values
  ('f3000000-0000-4000-8000-000000000001', 'Booking clinic'), ('f3000000-0000-4000-8000-000000000002', 'Other clinic');
insert into clinical_private.staff(user_id, organization_id, display_name, role) values
  ('f1000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'Dr. Assigned', 'doctor'),
  ('f1000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000001', 'Dr. Colleague', 'doctor'),
  ('f1000000-0000-4000-8000-000000000003', 'f3000000-0000-4000-8000-000000000001', 'Nurse', 'nurse'),
  ('f1000000-0000-4000-8000-000000000004', 'f3000000-0000-4000-8000-000000000002', 'Dr. Elsewhere', 'doctor');
insert into clinical_private.patients(id, account_id, display_name, identity_label, identity_verified) values
  ('f4000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000005', 'Booking patient', 'BK-1', true),
  ('f4000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000006', 'Second patient', 'BK-2', true);
insert into clinical_private.organization_patients(organization_id, patient_id) values
  ('f3000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001'),
  ('f3000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000002');
insert into clinical_private.assignments(patient_id, organization_id, clinician_id)
values ('f4000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001');
create temp table cb_day as select (now() at time zone 'Europe/Stockholm')::date + 3 as d;
grant select on cb_day to authenticated;
set local role authenticated;

-- Free times: a block is split into equal times, overlaps are skipped, past and odd blocks are refused.
select pg_temp.cb_claims(1);
select pg_temp.cb_assert((public.clinician_calendar('add', jsonb_build_object('date', (select d from cb_day), 'from', '09:00', 'to', '10:00', 'minutes', 20))->>'added')::int = 3,
  '09:00–10:00 in 20 minutes gives three times');
select pg_temp.cb_assert((public.clinician_calendar('add', jsonb_build_object('date', (select d from cb_day), 'from', '09:30', 'to', '10:30', 'minutes', 20))->>'added')::int = 1,
  'only the time that does not overlap is added');
select pg_temp.cb_denied($q$select public.clinician_calendar('add', jsonb_build_object('date', (select d - 10 from cb_day), 'from', '09:00', 'to', '10:00', 'minutes', 20))$q$, '22023', 'past block refused');
select pg_temp.cb_denied($q$select public.clinician_calendar('add', jsonb_build_object('date', (select d from cb_day), 'from', '09:00', 'to', '10:00', 'minutes', 2))$q$, '22023', 'too short times refused');
select pg_temp.cb_assert(jsonb_array_length(public.clinician_calendar('list', jsonb_build_object('from', (select d from cb_day), 'days', 1))->'times') = 4, 'four free times listed');

-- A booking request needs free times of one's own.
select pg_temp.cb_claims(2);
select pg_temp.cb_denied($q$select public.clinician_patient_messages('book', '{"patient":"f4000000-0000-4000-8000-000000000001","visit_type":"video"}')$q$, '22023', 'no free times, no request');
select pg_temp.cb_claims(1);
select pg_temp.cb_denied($q$select public.clinician_patient_messages('book', '{"patient":"f4000000-0000-4000-8000-000000000001","visit_type":"house"}')$q$, '22023', 'unknown visit type');
select public.clinician_patient_messages('send', '{"patient":"f4000000-0000-4000-8000-000000000001","body":"Hej! Vi behöver ses."}');
select pg_temp.cb_assert((select (r->>'free_times')::int = 4 and exists (select 1 from jsonb_array_elements(r->'messages') m
    where m->>'kind' = 'booking' and m->'booking'->>'status' = 'open' and m->'booking'->>'visit_type' = 'video'
      and m->>'body' = 'Välj en tid för videosamtal nedan.')
  from (select public.clinician_patient_messages('book', '{"patient":"f4000000-0000-4000-8000-000000000001","visit_type":"video"}') as r) x),
  'the doctor asks the patient to book a video call');

-- The patient sees the request with the doctor's free times and books one.
select pg_temp.cb_claims(5);
create temp table cb_req as select (m->'booking'->>'id')::uuid as id from jsonb_array_elements(public.gohealth_messages()->'messages') m where m->>'kind' = 'booking';
select pg_temp.cb_assert((select count(*) = 1 from cb_req), 'the patient sees one booking request');
create temp table cb_slots as select (s->>'id')::uuid as id, n from jsonb_array_elements(public.gohealth_booking_slots((select id from cb_req))->'slots') with ordinality as x(s, n);
select pg_temp.cb_assert((select count(*) = 4 from cb_slots), 'the patient sees four free times');
select pg_temp.cb_assert((select r->'upcoming'->0->>'visit_type' = 'video' and r->'upcoming'->0->>'clinician_name' = 'Dr. Assigned'
    and exists (select 1 from jsonb_array_elements(r->'messages') m where m->>'kind' = 'booked' and m->>'body' like 'Bokade %· Videosamtal')
    and exists (select 1 from jsonb_array_elements(r->'messages') m where m->>'kind' = 'booking' and m->'booking'->>'status' = 'booked'
      and (m->'booking'->>'can_unbook')::boolean)
  from (select public.gohealth_book_time((select id from cb_req), (select id from cb_slots where n = 1)) as r) x), 'booked, confirmed in the chat and upcoming');
select pg_temp.cb_denied($q$select public.gohealth_book_time((select id from cb_req), (select id from cb_slots where n = 2))$q$, '22023', 'a booked request cannot be booked twice');
select pg_temp.cb_claims(6);
select pg_temp.cb_denied($q$select public.gohealth_booking_slots((select id from cb_req))$q$, '22023', 'another patient cannot see the times');
select pg_temp.cb_denied($q$select public.gohealth_book_time((select id from cb_req), (select id from cb_slots where n = 2))$q$, '22023', 'another patient cannot book');

-- The doctor's calendar shows who booked; a booked time cannot be removed, a free one can.
select pg_temp.cb_claims(1);
select pg_temp.cb_assert((select (r->'upcoming'->0->>'patient') = 'Booking patient'
    and exists (select 1 from jsonb_array_elements(r->'times') t where t->'booking'->>'patient' = 'Booking patient')
  from (select public.clinician_calendar('list', jsonb_build_object('from', (select d from cb_day), 'days', 1)) as r) x), 'the booking is in the calendar');
select pg_temp.cb_assert((public.clinician_overview()->'counts'->>'messages')::int = 0, 'a booking does not wait for an answer');
select pg_temp.cb_denied($q$select public.clinician_calendar('remove', jsonb_build_object('slot', (select id from cb_slots where n = 1)))$q$, '22023', 'booked time kept');
select public.clinician_calendar('remove', jsonb_build_object('slot', (select id from cb_slots where n = 4)));
select pg_temp.cb_assert(jsonb_array_length(public.clinician_calendar('list', jsonb_build_object('from', (select d from cb_day), 'days', 1))->'times') = 3, 'free time removed');
select pg_temp.cb_claims(2);
select pg_temp.cb_denied($q$select public.clinician_calendar('remove', jsonb_build_object('slot', (select id from cb_slots where n = 2)))$q$, '22023', 'a colleague cannot remove my times');

-- The patient cancels and books again; the cancellation waits for the care team.
select pg_temp.cb_claims(5);
select pg_temp.cb_assert((select r->'upcoming' = '[]'::jsonb from (select public.gohealth_unbook_time((select id from cb_req)) as r) x), 'cancelled by the patient');
select pg_temp.cb_claims(1);
select pg_temp.cb_assert((public.clinician_overview()->'counts'->>'messages')::int = 1, 'the cancellation waits for the doctor');
select pg_temp.cb_claims(5);
select public.gohealth_book_time((select id from cb_req), (select id from cb_slots where n = 2));

-- One booking per time, also for another patient.
select pg_temp.cb_claims(1);
select public.clinician_patient_messages('book', '{"patient":"f4000000-0000-4000-8000-000000000002","visit_type":"phone","body":"Boka ett telefonsamtal."}');
select pg_temp.cb_claims(6);
create temp table cb_req2 as select (m->'booking'->>'id')::uuid as id from jsonb_array_elements(public.gohealth_messages()->'messages') m where m->>'kind' = 'booking';
select pg_temp.cb_assert((select count(*) = 2 from jsonb_array_elements(public.gohealth_booking_slots((select id from cb_req2))->'slots')), 'booked times are not offered');
select pg_temp.cb_denied($q$select public.gohealth_book_time((select id from cb_req2), (select id from cb_slots where n = 2))$q$, '22023', 'a booked time cannot be taken');
select public.gohealth_book_time((select id from cb_req2), (select id from cb_slots where n = 3));

-- The doctor cancels the second patient's time; the patient is told and the time is free again.
select pg_temp.cb_claims(1);
select public.clinician_patient_messages('unbook', jsonb_build_object('patient', 'f4000000-0000-4000-8000-000000000002', 'booking', (select id from cb_req2)));
select pg_temp.cb_claims(6);
select pg_temp.cb_assert((select r->'upcoming' = '[]'::jsonb and exists (select 1 from jsonb_array_elements(r->'messages') m
    where m->>'kind' = 'unbooked' and m->>'sender' = 'clinician' and m->>'body' like 'Din tid % är avbokad.')
  from (select public.gohealth_messages() as r) x), 'the patient is told the time is cancelled');
select pg_temp.cb_denied($q$select public.gohealth_booking_slots((select id from cb_req2))$q$, '22023', 'a withdrawn request cannot be booked');

-- Closing the chat: gone from the patient's app, kept with the care team; open requests lapse, the booked time stays.
select pg_temp.cb_claims(5);
select public.gohealth_send_message('Tack!');
select pg_temp.cb_claims(1);
select public.clinician_patient_messages('book', '{"patient":"f4000000-0000-4000-8000-000000000001","visit_type":"clinic"}');
select public.clinician_patient_messages('archive', '{"patient":"f4000000-0000-4000-8000-000000000001"}');
select pg_temp.cb_denied($q$select public.clinician_patient_messages('archive', '{"patient":"f4000000-0000-4000-8000-000000000001"}')$q$, '22023', 'nothing left to archive');
select pg_temp.cb_assert((select bool_and(m->>'archived_at' is not null) and count(*) >= 6
    and count(*) filter (where m->'booking'->>'status' = 'withdrawn') = 1 and count(*) filter (where m->'booking'->>'status' = 'booked') = 1
  from jsonb_array_elements(public.clinician_patient_messages('thread', '{"patient":"f4000000-0000-4000-8000-000000000001"}')->'messages') m),
  'the care team keeps the closed chat; the open request lapsed, the booking stays');
select pg_temp.cb_assert((select (c->>'archived')::boolean and (c->>'waiting')::int = 0
  from jsonb_array_elements(public.clinician_message_inbox('list')->'conversations') c where c->>'display_name' = 'Booking patient'), 'archived in the inbox, nothing waiting');
select pg_temp.cb_assert((public.clinician_overview()->'counts'->>'messages')::int = 0, 'closing handles waiting messages');
select pg_temp.cb_claims(5);
select pg_temp.cb_assert((select r->'messages' = '[]'::jsonb and not (r->>'can_reply')::boolean and jsonb_array_length(r->'upcoming') = 1
  from (select public.gohealth_messages() as r) x), 'the chat is gone for the patient; the booked time is still shown');
select pg_temp.cb_denied($q$select public.gohealth_send_message('Hallå?')$q$, '22023', 'no reply into a closed chat');

-- Cancelling after the chat was closed reaches the care team as a new conversation.
select pg_temp.cb_assert((select jsonb_array_length(r->'messages') = 1 and r->'upcoming' = '[]'::jsonb
  from (select public.gohealth_unbook_time((select id from cb_req)) as r) x), 'cancelled after closing');
select pg_temp.cb_denied($q$select public.gohealth_booking_slots((select id from cb_req))$q$, '22023', 'the closed request does not open again');
select pg_temp.cb_claims(1);
select pg_temp.cb_assert((select not (c->>'archived')::boolean and (c->>'waiting')::int = 1
  from jsonb_array_elements(public.clinician_message_inbox('list')->'conversations') c where c->>'display_name' = 'Booking patient'), 'active again, waiting');
select public.clinician_patient_messages('send', '{"patient":"f4000000-0000-4000-8000-000000000001","body":"Vi hörs."}');
select pg_temp.cb_claims(5);
select pg_temp.cb_assert((select jsonb_array_length(r->'messages') = 2 and (r->>'can_reply')::boolean from (select public.gohealth_messages() as r) x),
  'a new conversation, without the closed one');

-- Quick replies are personal.
select pg_temp.cb_claims(1);
create temp table cb_qr as select (r->'replies'->0->>'id')::uuid as id, jsonb_array_length(r->'replies') as n
  from (select public.clinician_quick_replies('add', '{"body":"Tack, jag återkommer."}') as r) x;
select pg_temp.cb_assert((select n = 1 from cb_qr), 'quick reply saved');
select pg_temp.cb_denied($q$select public.clinician_quick_replies('add', '{"body":"  "}')$q$, '22023', 'empty quick reply refused');
select pg_temp.cb_claims(2);
select pg_temp.cb_assert(public.clinician_quick_replies('list')->'replies' = '[]'::jsonb, 'a colleague does not see them');
select public.clinician_quick_replies('remove', jsonb_build_object('id', (select id from cb_qr)));
select pg_temp.cb_claims(1);
select pg_temp.cb_assert(jsonb_array_length(public.clinician_quick_replies('list')->'replies') = 1, 'a colleague cannot remove them');
select pg_temp.cb_assert(public.clinician_quick_replies('remove', jsonb_build_object('id', (select id from cb_qr)))->'replies' = '[]'::jsonb, 'removed');

-- Access.
select pg_temp.cb_claims(3);
select pg_temp.cb_denied($q$select public.clinician_patient_messages('archive', '{"patient":"f4000000-0000-4000-8000-000000000001"}')$q$, '42501', 'unassigned nurse cannot close the chat');
select pg_temp.cb_claims(4);
select pg_temp.cb_denied($q$select public.clinician_patient_messages('book', '{"patient":"f4000000-0000-4000-8000-000000000001","visit_type":"video"}')$q$, '42501', 'another clinic cannot ask for a booking');
select pg_temp.cb_claims(5);
select pg_temp.cb_denied($q$select public.clinician_calendar('list')$q$, '42501', 'patients have no calendar');
select pg_temp.cb_denied($q$select public.clinician_quick_replies('list')$q$, '42501', 'patients have no quick replies');
reset role;
set local role anon;
select pg_temp.cb_denied($q$select public.gohealth_booking_slots('f4000000-0000-4000-8000-000000000009')$q$, '42501', 'anonymous callers cannot see times');
select pg_temp.cb_denied($q$select public.clinician_calendar('list')$q$, '42501', 'anonymous callers have no calendar');
reset role;
select pg_temp.cb_assert((select count(*) filter (where action = 'booking.request') = 3 and count(*) filter (where action = 'booking.book') = 3
    and count(*) filter (where action = 'booking.unbook') = 2 and count(*) filter (where action = 'booking.cancel') = 1
    and count(*) filter (where action = 'messages.archive') = 1
  from clinical_private.audit where patient_id in ('f4000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000002')),
  'requests, bookings, cancellations and closing are audited');
select 'Chat booking tests passed: free times, booking requests, booking and cancelling, one booking per time, closing chats, quick replies, access, audit.' as result;
