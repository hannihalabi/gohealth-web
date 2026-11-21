-- Attestation queue: every draft waiting for review and publication, across the clinician's patients.
create function clinical_private.pending_attestations() returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  actor uuid := clinical_private.live_actor();
  n integer;
begin
  if not clinical_private.portal_assurance_sufficient() then
    raise exception 'Staff authentication required' using errcode = '42501';
  end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
    select r.id, r.patient_id, p.display_name, p.identity_label, p.identity_verified, r.kind, r.version, r.revision,
      r.replaces_id is not null as is_correction, r.created_at,
      jsonb_strip_nulls(jsonb_build_object('title', r.payload->>'title', 'sampledAt', r.payload->>'sampledAt',
        'modality', r.payload->>'modality', 'bodyPart', r.payload->>'bodyPart', 'vaccine', r.payload->>'vaccine')) as payload,
      (select s2.display_name from clinical_private.staff s2 where s2.user_id = r.created_by and s2.organization_id = r.organization_id) as created_by_name
    from clinical_private.records r
    join clinical_private.patients p on p.id = r.patient_id
    join clinical_private.assignments a on a.patient_id = r.patient_id and a.organization_id = r.organization_id
      and a.clinician_id = actor and a.active
    join clinical_private.staff s on s.user_id = actor and s.organization_id = r.organization_id and s.active
    where r.status = 'draft' and r.superseded_at is null
    order by r.created_at desc limit 200) x), '[]'::jsonb);
end $$;
revoke all on function clinical_private.pending_attestations() from public, anon, authenticated;
grant execute on function clinical_private.pending_attestations() to authenticated;
create function public.clinician_pending_attestations() returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.pending_attestations()$$;
revoke all on function public.clinician_pending_attestations() from public, anon;
grant execute on function public.clinician_pending_attestations() to authenticated;
