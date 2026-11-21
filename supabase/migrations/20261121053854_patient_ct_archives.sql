-- Patient access is limited to authenticated downloads of current published attachments.
create function clinical_private.patient_ct_archive_download_access(p_name text, p_version text) returns boolean
language plpgsql stable security definer set search_path = pg_catalog as $$
declare
  actor uuid;
begin
  actor := clinical_private.live_actor();
  return exists (
    select 1
    from clinical_private.ct_archives a
    join clinical_private.patients p on p.id = a.patient_id
    join clinical_private.records r on r.patient_id = a.patient_id and r.organization_id = a.organization_id
    where a.object_name = p_name and a.storage_version = p_version and a.cancelled_at is null
      and p.account_id = actor and p.identity_verified
      and r.kind = 'imaging' and r.status = 'published' and r.superseded_at is null
      and r.payload ? 'archiveId' and r.payload->>'archiveId' = a.id::text
  );
exception when insufficient_privilege or invalid_text_representation then
  return false;
end $$;

revoke all on function clinical_private.patient_ct_archive_download_access(text, text) from public, anon, authenticated;
grant execute on function clinical_private.patient_ct_archive_download_access(text, text) to authenticated;

create policy patient_published_ct_archive_download on storage.objects for select to authenticated
using (
  bucket_id = 'clinical-ct-archives'
  and (select storage.allow_only_operation('storage.object.get_authenticated'))
  and clinical_private.patient_ct_archive_download_access(name, version)
);

-- The existing gateway owns record visibility, request limits and the audit event.
-- Keep the patient response compatible with older app builds and add only attachment metadata.
create function clinical_private.patient_data_with_ct_archives() returns jsonb
language sql security definer set search_path = pg_catalog as $$
  select jsonb_build_object('records', coalesce(jsonb_agg(
    jsonb_set(r.value, '{payload}', (r.value->'payload') - 'archiveId') ||
    case when o.name is null then '{}'::jsonb else jsonb_build_object(
      'image_archive', jsonb_build_object('id', a.id, 'size', a.expected_size, 'imageCount', a.image_count)
    ) end
    order by r.ordinality
  ), '[]'::jsonb))
  from jsonb_array_elements(clinical_private.gateway('patient_data', '{}'::jsonb)->'records') with ordinality r
  left join clinical_private.ct_archives a
    on r.value->>'kind' = 'imaging' and a.object_name = (r.value->'payload'->>'archiveId') || '.zip'
    and a.patient_id = (r.value->>'patient_id')::uuid and a.cancelled_at is null
  left join storage.objects o
    on o.bucket_id = 'clinical-ct-archives' and o.name = a.object_name and o.version = a.storage_version
$$;

revoke all on function clinical_private.patient_data_with_ct_archives() from public, anon, authenticated;
grant execute on function clinical_private.patient_data_with_ct_archives() to authenticated;

create or replace function public.gohealth_patient_data() returns jsonb
language sql security invoker set search_path = pg_catalog as $$
  select clinical_private.patient_data_with_ct_archives()
$$;
