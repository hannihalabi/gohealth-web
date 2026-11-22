-- Patient directory for the clinician portal: "mine" (assigned to the caller) or "all" patients in the caller's clinic.
-- Listing everyone shows names, identity and the assigned doctor only. Opening a patient still requires an active care relation.
create function clinical_private.patient_directory(p_query text, p_scope text) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  actor uuid := clinical_private.live_actor();
  n integer;
begin
  if not clinical_private.portal_assurance_sufficient() then
    raise exception 'Staff authentication required' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('mine', 'all') or length(coalesce(p_query, '')) > 120 then
    raise exception 'Invalid directory request' using errcode = '22023';
  end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.display_name, x.id) from (
    select p.id, p.display_name, p.identity_label, p.identity_verified, p.last_sync_at,
      exists (select 1 from clinical_private.assignments a
        join clinical_private.staff s on s.user_id = a.clinician_id and s.organization_id = a.organization_id
        where a.patient_id = p.id and a.organization_id = op.organization_id and a.clinician_id = actor and a.active and s.active) as assigned_to_me,
      coalesce((select jsonb_agg(s2.display_name order by s2.display_name) from clinical_private.assignments a2
        join clinical_private.staff s2 on s2.user_id = a2.clinician_id and s2.organization_id = a2.organization_id
        where a2.patient_id = p.id and a2.organization_id = op.organization_id and a2.active and s2.active and s2.role = 'doctor'), '[]'::jsonb) as doctors
    from clinical_private.organization_patients op
    join clinical_private.patients p on p.id = op.patient_id
    where op.active
      and exists (select 1 from clinical_private.staff s where s.user_id = actor and s.organization_id = op.organization_id and s.active)
      and (p_scope = 'all' or exists (select 1 from clinical_private.assignments a
        join clinical_private.staff s on s.user_id = a.clinician_id and s.organization_id = a.organization_id
        where a.patient_id = p.id and a.organization_id = op.organization_id and a.clinician_id = actor and a.active and s.active))
      and (coalesce(p_query, '') = '' or p.identity_label = p_query or position(lower(p_query) in lower(p.display_name)) > 0)
    order by p.display_name, p.id limit 200) x), '[]'::jsonb);
end $$;
revoke all on function clinical_private.patient_directory(text, text) from public, anon, authenticated;
grant execute on function clinical_private.patient_directory(text, text) to authenticated;
create function public.clinician_patient_directory(p_query text default '', p_scope text default 'mine') returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.patient_directory(p_query, p_scope)$$;
revoke all on function public.clinician_patient_directory(text, text) from public, anon;
grant execute on function public.clinician_patient_directory(text, text) to authenticated;
