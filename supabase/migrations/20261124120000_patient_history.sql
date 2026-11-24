-- Patient history: who did what to this patient, readable. Every clinician with a care relation sees the whole
-- clinic's actions on the patient (name, role, record), so a mistake can be traced to its author and corrected.
-- Only metadata: never test values or message text. Reading the history is itself logged.
create function clinical_private.patient_history(p_patient uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor(); org uuid; result jsonb;
begin
  if not clinical_private.portal_assurance_sufficient()
    or not exists (select 1 from clinical_private.staff where user_id = actor and active)
  then raise exception 'Staff authentication required' using errcode = '42501'; end if;
  perform clinical_private.take_request(actor);
  org := clinical_private.care_organization(actor, p_patient);
  if org is null then raise exception 'Active care relation required' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'at', e.created_at, 'action', e.action,
      'actor', case when e.actor_id = pat.account_id then pat.display_name else s.display_name end,
      'role', case when e.actor_id = pat.account_id then 'patient' else s.role end,
      'record', case when r.id is null then null else jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.payload->>'title',
        'status', r.status, 'revision', r.revision) end) order by e.created_at desc, e.id desc), '[]'::jsonb) into result
  from (select * from clinical_private.audit where patient_id = p_patient order by created_at desc, id desc limit 300) e
  cross join clinical_private.patients pat
  left join clinical_private.staff s on s.user_id = e.actor_id and s.organization_id = org
  left join clinical_private.records r on r.id = e.record_id
  where pat.id = p_patient;
  insert into clinical_private.audit (actor_id, patient_id, action) values (actor, p_patient, 'patient.read_history');
  return jsonb_build_object('events', result);
end $$;
revoke all on function clinical_private.patient_history(uuid) from public, anon, authenticated;
grant execute on function clinical_private.patient_history(uuid) to authenticated;
create function public.clinician_patient_history(p_patient uuid) returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.patient_history(p_patient)$$;
revoke all on function public.clinician_patient_history(uuid) from public, anon;
grant execute on function public.clinician_patient_history(uuid) to authenticated;
