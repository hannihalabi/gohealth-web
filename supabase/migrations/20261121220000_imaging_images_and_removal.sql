-- Imaging: attach image archives to any modality, and let the care team remove images that were added by mistake.
-- Removal keeps the written report, marks the archive removed with a reason and an audit event, and deletes the stored bytes.
alter table clinical_private.ct_archives
  add column removed_at timestamptz, add column removed_by uuid references auth.users(id), add column removal_reason text,
  add constraint ct_archives_removal_complete check ((removed_at is null and removed_by is null and removal_reason is null)
    or (removed_at is not null and removed_by is not null and length(btrim(removal_reason)) between 1 and 500));


create or replace function clinical_private.ct_archive_object_access(p_name text, p_version text, p_action text) returns boolean
language plpgsql stable security definer set search_path = pg_catalog as $$
declare
  archive clinical_private.ct_archives;
  actor uuid;
begin
  select * into archive from clinical_private.ct_archives where object_name = p_name;
  if archive.id is null or not clinical_private.portal_assurance_sufficient() then return false; end if;
  actor := clinical_private.live_actor();
  if clinical_private.ct_archive_organization(actor, archive.patient_id) is distinct from archive.organization_id then return false; end if;

  if p_action = 'insert' then
    return archive.created_by = actor and archive.expires_at > now()
      and archive.cancelled_at is null and archive.storage_version is null
      and archive.upload_session_id = (auth.jwt()->>'session_id')::uuid;
  elsif p_action = 'delete' then
    return (archive.created_by = actor and archive.first_record_id is null and archive.cancelled_at is not null)
      or archive.removed_at is not null;
  elsif p_action = 'select' then
    if archive.cancelled_at is not null then
      -- Storage DELETE also checks visibility of the rows it removes.
      return archive.created_by = actor and archive.first_record_id is null;
    end if;
    if archive.removed_at is not null then return true; end if;
    if archive.storage_version is not null and archive.storage_version is distinct from p_version then return false; end if;
    if archive.first_record_id is null then return archive.created_by = actor and archive.expires_at > now(); end if;
    return exists (
      select 1 from clinical_private.records r
      where r.kind = 'imaging' and r.payload ? 'archiveId' and r.payload->>'archiveId' = archive.id::text
        and r.patient_id = archive.patient_id and r.organization_id = archive.organization_id
    );
  end if;
  return false;
exception when insufficient_privilege then
  return false;
end $$;

create or replace function clinical_private.guard_record() returns trigger
language plpgsql set search_path = pg_catalog as $$
declare
  field text;
  allowed text[];
  original clinical_private.records;
  archive clinical_private.ct_archives;
begin
  if tg_op = 'UPDATE' and old.status = 'published' then
    if (to_jsonb(new) - 'superseded_at') is distinct from (to_jsonb(old) - 'superseded_at')
      or old.superseded_at is not null or new.superseded_at is null then
      raise exception 'Published records are immutable' using errcode = '42501';
    end if;
    return new;
  end if;
  perform clinical_private.validate_payload(new.kind, new.payload);
  if new.payload->>'sampledAt' !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then raise exception 'Timezone required' using errcode = '22023'; end if;
  allowed := array['title', 'sampledAt', 'source', 'comment'];
  if new.kind = 'lab' then allowed := allowed || array['observations'];
  elsif new.kind = 'vaccination' then allowed := allowed || array['vaccine', 'dose', 'batch', 'location'];
  else
    allowed := allowed || array['modality', 'bodyPart', 'conclusion', 'studyId', 'archiveId'];
    foreach field in array array['modality', 'bodyPart', 'conclusion', 'studyId'] loop
      if jsonb_typeof(new.payload->field) is distinct from 'string' then raise exception 'Text field required' using errcode = '22023'; end if;
    end loop;
  end if;
  if exists (select 1 from jsonb_object_keys(new.payload) k where not k = any(allowed)) then raise exception 'Unknown payload field' using errcode = '22023'; end if;
  if new.replaces_id is not null then
    select * into original from clinical_private.records where id = new.replaces_id;
    if original.patient_id is distinct from new.patient_id or original.organization_id is distinct from new.organization_id
      or original.kind is distinct from new.kind or original.status <> 'published' or original.version + 1 <> new.version then
      raise exception 'Invalid correction lineage' using errcode = '42501';
    end if;
  end if;
  if new.payload ? 'archiveId' then
    if new.kind <> 'imaging' or jsonb_typeof(new.payload->'archiveId') is distinct from 'string' then
      raise exception 'Archive requires an imaging record' using errcode = '22023';
    end if;
    select * into archive from clinical_private.ct_archives a where a.id = (new.payload->>'archiveId')::uuid for update;
    if archive.storage_version is null or archive.cancelled_at is not null or archive.removed_at is not null
      or archive.patient_id is distinct from new.patient_id or archive.organization_id is distinct from new.organization_id then
      raise exception 'CT archive unavailable for this patient' using errcode = '42501';
    end if;
    if archive.first_record_id is null then
      if archive.created_by is distinct from auth.uid() or archive.expires_at <= now() then
        raise exception 'CT archive unavailable for this author' using errcode = '42501';
      end if;
      update clinical_private.ct_archives a set first_record_id = new.id where a.id = archive.id;
    elsif archive.first_record_id <> new.id and original.payload->>'archiveId' is distinct from archive.id::text then
      raise exception 'CT archive already belongs to a different record' using errcode = '42501';
    end if;
    new.payload := jsonb_set(new.payload, '{archiveId}', to_jsonb(archive.id));
  end if;
  return new;
end $$;

create or replace function clinical_private.ct_archive(p_action text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  actor uuid := clinical_private.live_actor();
  patient uuid;
  organization uuid;
  archive clinical_private.ct_archives;
  record clinical_private.records;
  archive_size integer;
  object_version text;
  count_images integer;
  request_count integer;
  reason text;
begin
  if not clinical_private.portal_assurance_sufficient() then
    raise exception 'Staff authentication required' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('begin', 'inspect', 'finish', 'read', 'cancel', 'remove')
    or jsonb_typeof(p_args) is distinct from 'object' or octet_length(p_args::text) > 1024 then
    raise exception 'Invalid CT archive request' using errcode = '22023';
  end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1
  returning requests into request_count;
  if request_count > 120 then raise exception 'Request limit' using errcode = '42501'; end if;

  if p_action = 'begin' then
    patient := (p_args->>'patientId')::uuid;
    archive_size := (p_args->>'size')::integer;
    if jsonb_typeof(p_args->'size') is distinct from 'number' or archive_size not between 22 and 52428800 then
      raise exception 'Invalid CT archive size' using errcode = '22023';
    end if;
    organization := clinical_private.ct_archive_organization(actor, patient);
    if organization is null then raise exception 'Active care relation required' using errcode = '42501'; end if;
    -- The per-actor request row above serializes reservations for this caller.
    if (select count(*) from clinical_private.ct_archives a where a.created_by = actor
      and a.expires_at > now() and a.first_record_id is null and a.cancelled_at is null) >= 5 then
      raise exception 'Too many pending CT uploads' using errcode = '22023';
    end if;
    insert into clinical_private.ct_archives (patient_id, organization_id, created_by, upload_session_id, expected_size)
    values (patient, organization, actor, (auth.jwt()->>'session_id')::uuid, archive_size) returning * into archive;
    return jsonb_build_object('id', archive.id, 'path', archive.object_name);
  end if;

  if p_action = 'remove' then
    select * into record from clinical_private.records r where r.id = (p_args->>'recordId')::uuid and r.kind = 'imaging';
    if record.id is null or clinical_private.ct_archive_organization(actor, record.patient_id) is distinct from record.organization_id then
      raise exception 'CT archive unavailable' using errcode = '42501';
    end if;
    reason := btrim(coalesce(p_args->>'reason', ''));
    if length(reason) not between 1 and 500 then raise exception 'Removal reason required' using errcode = '22023'; end if;
    if record.status = 'published' and not exists (select 1 from clinical_private.staff s
      where s.user_id = actor and s.organization_id = record.organization_id and s.active and s.role = 'doctor') then
      raise exception 'A doctor must remove published images' using errcode = '42501';
    end if;
    select * into archive from clinical_private.ct_archives a where a.id = (record.payload->>'archiveId')::uuid
      and a.patient_id = record.patient_id and a.organization_id = record.organization_id for update;
    if archive.id is null then raise exception 'CT archive unavailable' using errcode = '42501'; end if;
    if archive.removed_at is null then
      update clinical_private.ct_archives a set removed_at = now(), removed_by = actor, removal_reason = reason where a.id = archive.id;
      insert into clinical_private.audit (actor_id, patient_id, action, record_id)
      values (actor, archive.patient_id, 'record.remove_ct_archive', record.id);
    end if;
    return jsonb_build_object('id', archive.id, 'path', archive.object_name);
  end if;

  if p_action = 'read' then
    select * into record from clinical_private.records r where r.id = (p_args->>'recordId')::uuid and r.kind = 'imaging';
    if record.id is null or clinical_private.ct_archive_organization(actor, record.patient_id) is distinct from record.organization_id then
      raise exception 'CT archive unavailable' using errcode = '42501';
    end if;
    select * into archive from clinical_private.ct_archives a where a.id = (record.payload->>'archiveId')::uuid
      and a.patient_id = record.patient_id and a.organization_id = record.organization_id;
    if archive.id is not null and archive.removed_at is not null then
      return jsonb_build_object('removed', true, 'removedAt', archive.removed_at, 'reason', archive.removal_reason);
    end if;
    if archive.storage_version is null then raise exception 'CT archive unavailable' using errcode = '42501'; end if;
  else
    select * into archive from clinical_private.ct_archives a where a.id = (p_args->>'id')::uuid and a.created_by = actor for update;
    if archive.id is null or clinical_private.ct_archive_organization(actor, archive.patient_id) is distinct from archive.organization_id then
      raise exception 'CT archive unavailable' using errcode = '42501';
    end if;
    if p_action = 'cancel' then
      if archive.first_record_id is not null then raise exception 'CT archive is attached to a record' using errcode = '42501'; end if;
      update clinical_private.ct_archives a set cancelled_at = now()
      where a.id = archive.id and a.cancelled_at is null;
      return jsonb_build_object('id', archive.id, 'path', archive.object_name);
    end if;
    if archive.cancelled_at is not null or (archive.first_record_id is null and archive.expires_at <= now()) then
      raise exception 'CT archive unavailable' using errcode = '42501';
    end if;
  end if;

  select o.version into object_version from storage.objects o
  where o.bucket_id = 'clinical-ct-archives' and o.name = archive.object_name
    and o.metadata->>'size' = archive.expected_size::text and o.metadata->>'mimetype' = 'application/zip';
  if object_version is null or (archive.storage_version is not null and object_version <> archive.storage_version) then
    raise exception 'CT archive upload has not completed' using errcode = '22023';
  end if;

  if p_action = 'finish' and archive.storage_version is null then
    count_images := (p_args->>'imageCount')::integer;
    if jsonb_typeof(p_args->'imageCount') is distinct from 'number' or count_images not between 1 and 10000 then
      raise exception 'Invalid CT image count' using errcode = '22023';
    end if;
    update clinical_private.ct_archives a set storage_version = object_version, image_count = count_images
    where a.id = archive.id returning * into archive;
  elsif p_action = 'read' then
    insert into clinical_private.audit (actor_id, patient_id, action, record_id)
    values (actor, archive.patient_id, 'record.download_ct_archive', record.id);
  end if;
  return jsonb_strip_nulls(jsonb_build_object('id', archive.id, 'path', archive.object_name,
    'size', archive.expected_size, 'imageCount', archive.image_count));
end $$;

create or replace function clinical_private.patient_ct_archive_download_access(p_name text, p_version text) returns boolean
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
    where a.object_name = p_name and a.storage_version = p_version and a.cancelled_at is null and a.removed_at is null
      and p.account_id = actor and p.identity_verified
      and r.kind = 'imaging' and r.status = 'published' and r.superseded_at is null
      and r.payload ? 'archiveId' and r.payload->>'archiveId' = a.id::text
  );
exception when insufficient_privilege or invalid_text_representation then
  return false;
end $$;

create or replace function clinical_private.patient_data_with_ct_archives() returns jsonb
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
    and a.patient_id = (r.value->>'patient_id')::uuid and a.cancelled_at is null and a.removed_at is null
  left join storage.objects o
    on o.bucket_id = 'clinical-ct-archives' and o.name = a.object_name and o.version = a.storage_version
$$;
