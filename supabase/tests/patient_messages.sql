-- Execute inside a transaction and roll back. Synthetic accounts only.
-- Users: 1 assigned doctor, 2 colleague doctor, 3 unassigned nurse, 4 doctor in another clinic, 5 patient, 6 patient without messages.
create function pg_temp.pm_assert(condition boolean, label text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'Failed: %', label; end if; end $$;
create function pg_temp.pm_denied(statement text, state text, label text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'Unexpected success: %', label;
exception when others then
  if sqlstate is distinct from state then raise; end if;
end $$;
create function pg_temp.pm_claims(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'e6000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'session_id', 'e7000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'aal', 'aal1', 'amr', jsonb_build_array(jsonb_build_object('method', 'password')))::text, true);
end $$;
update clinical_private.portal_settings set mfa_required = false;
insert into auth.users(id, email, email_confirmed_at)
select ('e6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'messages-' || n || '@example.invalid', now() from generate_series(1, 6) n;
insert into auth.sessions(id, user_id)
select ('e7000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ('e6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid from generate_series(1, 6) n;
insert into clinical_private.organizations(id, name) values
  ('e8000000-0000-4000-8000-000000000001', 'Message clinic'), ('e8000000-0000-4000-8000-000000000002', 'Other clinic');
insert into clinical_private.staff(user_id, organization_id, display_name, role) values
  ('e6000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000001', 'Dr. Assigned', 'doctor'),
  ('e6000000-0000-4000-8000-000000000002', 'e8000000-0000-4000-8000-000000000001', 'Dr. Colleague', 'doctor'),
  ('e6000000-0000-4000-8000-000000000003', 'e8000000-0000-4000-8000-000000000001', 'Nurse', 'nurse'),
  ('e6000000-0000-4000-8000-000000000004', 'e8000000-0000-4000-8000-000000000002', 'Dr. Elsewhere', 'doctor');
insert into clinical_private.patients(id, account_id, display_name, identity_label, identity_verified) values
  ('e9000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000005', 'Message patient', 'MSG-1', true),
  ('e9000000-0000-4000-8000-000000000002', 'e6000000-0000-4000-8000-000000000006', 'Quiet patient', 'MSG-2', true);
insert into clinical_private.organization_patients(organization_id, patient_id) values
  ('e8000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000001'),
  ('e8000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000002');
insert into clinical_private.assignments(patient_id, organization_id, clinician_id)
values ('e9000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001');
set local role authenticated;

-- A patient cannot start a conversation.
select pg_temp.pm_claims(5);
select pg_temp.pm_assert(not (public.gohealth_messages()->>'can_reply')::boolean, 'no reply before the care team writes');
select pg_temp.pm_denied($q$select public.gohealth_send_message('Hej')$q$, '22023', 'patient cannot start a conversation');

-- The doctor writes; the patient sees it unread, reads it and replies.
select pg_temp.pm_claims(1);
select pg_temp.pm_denied($q$select public.clinician_patient_messages('send', '{"patient":"e9000000-0000-4000-8000-000000000001","body":"  "}')$q$, '22023', 'a message is required');
select public.clinician_patient_messages('send', '{"patient":"e9000000-0000-4000-8000-000000000001","body":"Hej! Kan du boka ett återbesök?"}');
select pg_temp.pm_claims(5);
select pg_temp.pm_assert((select count(*) = 1 and bool_and(m->>'sender' = 'clinician' and m->>'author_name' = 'Dr. Assigned' and m->>'read_at' is null)
  from jsonb_array_elements(public.gohealth_messages()->'messages') m), 'the patient sees one unread message from the doctor');
select public.gohealth_mark_messages_read();
select pg_temp.pm_assert((select bool_and(m->>'read_at' is not null) from jsonb_array_elements(public.gohealth_messages()->'messages') m), 'marked read');
select public.gohealth_send_message('Ja, jag bokar nästa vecka.');
select pg_temp.pm_claims(6);
select pg_temp.pm_assert(public.gohealth_messages()->'messages' = '[]'::jsonb, 'another patient sees nothing');

-- The reply waits for the care team on the start page of the assigned doctor, not of an uninvolved colleague.
select pg_temp.pm_claims(1);
select pg_temp.pm_assert((public.clinician_overview()->'counts'->>'messages')::int = 1, 'one conversation waiting');
select pg_temp.pm_assert((select m->>'display_name' = 'Message patient' and m->>'body' = 'Ja, jag bokar nästa vecka.' and (m->>'waiting')::int = 1
  from jsonb_array_elements(public.clinician_overview()->'messages') m), 'the waiting message is shown with the patient');
select pg_temp.pm_claims(2);
select pg_temp.pm_assert((public.clinician_overview()->'counts'->>'messages')::int = 0, 'an uninvolved colleague has nothing waiting');
select pg_temp.pm_assert((select count(*) = 2 from jsonb_array_elements(public.clinician_patient_messages('thread', '{"patient":"e9000000-0000-4000-8000-000000000001"}')->'messages')),
  'any doctor in the clinic can read the conversation');
select public.clinician_patient_messages('send', '{"patient":"e9000000-0000-4000-8000-000000000001","body":"Tack, vi ses då."}');
select pg_temp.pm_claims(1);
select pg_temp.pm_assert((public.clinician_overview()->'counts'->>'messages')::int = 0, 'a reply from any clinician handles the message');

-- Marking handled without replying.
select pg_temp.pm_claims(5);
select public.gohealth_send_message('Tack!');
select pg_temp.pm_claims(2);
select pg_temp.pm_assert((public.clinician_overview()->'counts'->>'messages')::int = 1, 'a participating colleague sees the new message');
select public.clinician_patient_messages('resolve', '{"patient":"e9000000-0000-4000-8000-000000000001"}');
select pg_temp.pm_assert((public.clinician_overview()->'counts'->>'messages')::int = 0, 'resolved without reply');

-- Access.
select pg_temp.pm_claims(3);
select pg_temp.pm_denied($q$select public.clinician_patient_messages('thread', '{"patient":"e9000000-0000-4000-8000-000000000001"}')$q$, '42501', 'unassigned nurse is denied');
select pg_temp.pm_claims(4);
select pg_temp.pm_denied($q$select public.clinician_patient_messages('send', '{"patient":"e9000000-0000-4000-8000-000000000001","body":"Hej"}')$q$, '42501', 'another clinic is denied');
select pg_temp.pm_denied($q$select public.gohealth_messages()$q$, '42501', 'staff accounts have no patient inbox');
reset role;
set local role anon;
select pg_temp.pm_denied($q$select public.gohealth_messages()$q$, '42501', 'anonymous callers are denied');
select pg_temp.pm_denied($q$select public.clinician_patient_messages('thread', '{"patient":"e9000000-0000-4000-8000-000000000001"}')$q$, '42501', 'anonymous callers cannot read');
reset role;
select pg_temp.pm_assert((select count(*) = 6 from clinical_private.audit where patient_id = 'e9000000-0000-4000-8000-000000000001' and action like 'messages.%'),
  'sends, replies, reads and resolutions are audited');
select 'Patient message tests passed: clinician-started conversations, patient replies, read state, waiting inbox, handling, clinic access, audit.' as result;
