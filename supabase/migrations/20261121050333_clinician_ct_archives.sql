-- A CT archive is a private attachment to a versioned clinician record.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clinical-ct-archives', 'clinical-ct-archives', false, 52428800, array['application/zip']);

create table clinical_private.ct_archives (
  id uuid primary key default gen_random_uuid(),
  object_name text generated always as (id::text || '.zip') stored unique,
  patient_id uuid not null references clinical_private.patients,
  organization_id uuid not null references clinical_private.organizations,
  created_by uuid not null references auth.users,
  upload_session_id uuid not null,
  expected_size integer not null check (expected_size between 22 and 52428800),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 hours',
  cancelled_at timestamptz,
  storage_version text,
  image_count integer check (image_count between 1 and 10000),
  first_record_id uuid references clinical_private.records deferrable initially deferred,
  check ((image_count is null) = (storage_version is null)),
  check (first_record_id is null or (cancelled_at is null and storage_version is not null))
);
alter table clinical_private.ct_archives enable row level security;
revoke all on clinical_private.ct_archives from public, anon, authenticated;
create index ct_archives_uploader_pending on clinical_private.ct_archives (created_by, expires_at)
  where first_record_id is null;
create index records_ct_archive on clinical_private.records ((payload->>'archiveId'))
  where kind = 'imaging' and payload ? 'archiveId';

-- Match the organization used by the existing clinical record gateway.
create function clinical_private.ct_archive_organization(p_actor uuid, p_patient uuid) returns uuid
language sql stable set search_path = pg_catalog as $$
  select a.organization_id
  from clinical_private.assignments a
  join clinical_private.staff s on s.user_id = a.clinician_id and s.organization_id = a.organization_id
  where a.patient_id = p_patient and a.clinician_id = p_actor and a.active and s.active
  order by a.organization_id limit 1
$$;

create function clinical_private.ct_archive_object_access(p_name text, p_version text, p_action text) returns boolean
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
    return archive.created_by = actor and archive.first_record_id is null and archive.cancelled_at is not null;
  elsif p_action = 'select' then
    if archive.cancelled_at is not null then
      -- Storage DELETE also checks visibility of the rows it removes.
      return archive.created_by = actor and archive.first_record_id is null;
    end if;
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

revoke all on function clinical_private.ct_archive_organization(uuid, uuid),
  clinical_private.ct_archive_object_access(text, text, text) from public, anon, authenticated;
grant execute on function clinical_private.ct_archive_object_access(text, text, text) to authenticated;

create policy clinician_ct_archive_insert on storage.objects for insert to authenticated
with check (bucket_id = 'clinical-ct-archives' and clinical_private.ct_archive_object_access(name, version, 'insert'));
create policy clinician_ct_archive_select on storage.objects for select to authenticated
using (bucket_id = 'clinical-ct-archives' and clinical_private.ct_archive_object_access(name, version, 'select'));
create policy clinician_ct_archive_cleanup on storage.objects for delete to authenticated
using (bucket_id = 'clinical-ct-archives' and clinical_private.ct_archive_object_access(name, version, 'delete'));

-- Storage verifies RLS while authorizing an upload and commits its object metadata
-- separately. Check the final write as well, including signed upload completions.
create function clinical_private.guard_ct_archive_object() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
declare archive clinical_private.ct_archives;
begin
  if tg_op = 'UPDATE' then
    if (old.bucket_id = 'clinical-ct-archives' or new.bucket_id = 'clinical-ct-archives')
      and (new.bucket_id, new.name, new.version, new.metadata)
        is distinct from (old.bucket_id, old.name, old.version, old.metadata) then
      raise exception 'CT archive object is immutable' using errcode = '42501';
    end if;
    return new;
  end if;
  -- Signed-URL and upload permission probes have no persisted Storage size.
  if new.bucket_id <> 'clinical-ct-archives' or new.metadata->>'size' is null then return new; end if;
  select * into archive from clinical_private.ct_archives where object_name = new.name for update;
  if archive.id is null or archive.cancelled_at is not null or archive.expires_at <= now()
    or archive.storage_version is not null or new.version is null
    or new.metadata->>'size' is distinct from archive.expected_size::text
    or new.metadata->>'mimetype' is distinct from 'application/zip'
    or not exists (select 1 from auth.sessions s where s.id = archive.upload_session_id
      and s.user_id = archive.created_by and (s.not_after is null or s.not_after > now()))
    or not exists (select 1 from auth.users u where u.id = archive.created_by
      and (u.banned_until is null or u.banned_until < now()))
    or clinical_private.ct_archive_organization(archive.created_by, archive.patient_id) is distinct from archive.organization_id then
    raise exception 'CT archive upload is unavailable' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function clinical_private.guard_ct_archive_object() from public, anon, authenticated;
create trigger guard_clinical_ct_archive_object before insert or update on storage.objects
for each row execute function clinical_private.guard_ct_archive_object();

create function clinical_private.ct_archive(p_action text, p_args jsonb) returns jsonb
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
begin
  if not clinical_private.portal_assurance_sufficient() then
    raise exception 'Staff authentication required' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('begin', 'inspect', 'finish', 'read', 'cancel')
    or jsonb_typeof(p_args) is distinct from 'object' or octet_length(p_args::text) > 512 then
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

  if p_action = 'read' then
    select * into record from clinical_private.records r where r.id = (p_args->>'recordId')::uuid and r.kind = 'imaging';
    if record.id is null or clinical_private.ct_archive_organization(actor, record.patient_id) is distinct from record.organization_id then
      raise exception 'CT archive unavailable' using errcode = '42501';
    end if;
    select * into archive from clinical_private.ct_archives a where a.id = (record.payload->>'archiveId')::uuid
      and a.patient_id = record.patient_id and a.organization_id = record.organization_id;
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

create function public.clinician_ct_archive(p_action text, p_args jsonb) returns jsonb
language sql security invoker set search_path = pg_catalog as $$
  select clinical_private.ct_archive(p_action, p_args)
$$;
revoke all on function clinical_private.ct_archive(text, jsonb),
  public.clinician_ct_archive(text, jsonb) from public, anon, authenticated;
grant execute on function clinical_private.ct_archive(text, jsonb),
  public.clinician_ct_archive(text, jsonb) to authenticated;

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
    if new.kind <> 'imaging' or new.payload->>'modality' <> 'CT' or jsonb_typeof(new.payload->'archiveId') is distinct from 'string' then
      raise exception 'Archive requires a CT record' using errcode = '22023';
    end if;
    select * into archive from clinical_private.ct_archives a where a.id = (new.payload->>'archiveId')::uuid for update;
    if archive.storage_version is null or archive.cancelled_at is not null
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

-- Patient clients read the existing clinical payload without clinician attachment IDs.
create or replace function public.gohealth_patient_data() returns jsonb
language sql security invoker set search_path = pg_catalog as $$
  select jsonb_build_object('records', coalesce(jsonb_agg(
    jsonb_set(r.value, '{payload}', (r.value->'payload') - 'archiveId') order by r.ordinality
  ), '[]'::jsonb))
  from jsonb_array_elements(clinical_private.gateway('patient_data', '{}'::jsonb)->'records') with ordinality r
$$;
