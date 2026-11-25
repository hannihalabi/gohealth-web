-- Colleagues: every active clinician sees the clinic's active staff for internal contact: name, role, e-mail and
-- work phone; for doctors the number of patients assigned to them, for everyone else the doctor whose team they
-- belong to. Contact details and workload counts only, never patient data. Each person sets their own work phone.
alter table clinical_private.staff add column phone text
  check (phone is null or phone ~ '^\+?[0-9][0-9 ()-]{5,22}$');

create function clinical_private.colleagues() returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor();
begin
  if not clinical_private.portal_assurance_sufficient()
    or not exists (select 1 from clinical_private.staff where user_id = actor and active)
  then raise exception 'Staff authentication required' using errcode = '42501'; end if;
  perform clinical_private.take_request(actor);
  return jsonb_build_object('colleagues', coalesce((select jsonb_agg(jsonb_build_object(
      'id', s.user_id, 'organization', o.name, 'name', s.display_name, 'role', s.role, 'email', u.email,
      'phone', s.phone, 'self', s.user_id = actor,
      'patients', case when s.role = 'doctor' then (
        select count(distinct a.patient_id) from clinical_private.assignments a
        join clinical_private.organization_patients op
          on op.patient_id = a.patient_id and op.organization_id = a.organization_id and op.active
        where a.organization_id = s.organization_id and a.clinician_id = s.user_id and a.active) end,
      'teamSize', case when s.role = 'doctor' then (
        select count(*) from clinical_private.care_teams t2
        join clinical_private.staff m on m.user_id = t2.nurse_id and m.organization_id = t2.organization_id and m.active
        where t2.organization_id = s.organization_id and t2.doctor_id = s.user_id) end,
      'team', case when s.role <> 'doctor' then d.display_name end
    ) order by s.display_name, s.user_id)
    from clinical_private.staff s
    join clinical_private.organizations o on o.id = s.organization_id
    join auth.users u on u.id = s.user_id
    left join clinical_private.care_teams t on t.organization_id = s.organization_id and t.nurse_id = s.user_id
    left join clinical_private.staff d on d.user_id = t.doctor_id and d.organization_id = t.organization_id and d.active
    where s.active
      and s.organization_id in (select organization_id from clinical_private.staff where user_id = actor and active)
  ), '[]'::jsonb));
end $$;
revoke all on function clinical_private.colleagues() from public, anon, authenticated;
grant execute on function clinical_private.colleagues() to authenticated;
create function public.clinician_colleagues() returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.colleagues()$$;
revoke all on function public.clinician_colleagues() from public, anon;
grant execute on function public.clinician_colleagues() to authenticated;

-- Sets the caller's own work phone in every clinic they work in; an empty value removes it.
create function clinical_private.set_own_phone(p_phone text) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor(); cleaned text := nullif(btrim(p_phone), '');
begin
  if not clinical_private.portal_assurance_sufficient()
    or not exists (select 1 from clinical_private.staff where user_id = actor and active)
  then raise exception 'Staff authentication required' using errcode = '42501'; end if;
  perform clinical_private.take_request(actor);
  if cleaned is not null and cleaned !~ '^\+?[0-9][0-9 ()-]{5,22}$' then
    raise exception 'Invalid phone number' using errcode = '22023';
  end if;
  update clinical_private.staff set phone = cleaned where user_id = actor and active;
  insert into clinical_private.administration_audit (organization_id, actor_id, action, subject_id)
  select organization_id, actor, 'staff.phone', actor from clinical_private.staff where user_id = actor and active;
  return jsonb_build_object('phone', cleaned);
end $$;
revoke all on function clinical_private.set_own_phone(text) from public, anon, authenticated;
grant execute on function clinical_private.set_own_phone(text) to authenticated;
create function public.clinician_set_phone(p_phone text) returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.set_own_phone(p_phone)$$;
revoke all on function public.clinician_set_phone(text) from public, anon;
grant execute on function public.clinician_set_phone(text) to authenticated;
