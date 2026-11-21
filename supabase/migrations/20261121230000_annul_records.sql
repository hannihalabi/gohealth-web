-- Annulment: a clinician can remove a whole examination (report and images) from the care record.
-- The row is kept, hidden from every current list and from the patient, with who, when and why for the audit trail.
alter table clinical_private.records
  add column annulled_at timestamptz, add column annulled_by uuid references auth.users(id), add column annulment_reason text,
  add constraint records_annulment_complete check ((annulled_at is null and annulled_by is null and annulment_reason is null)
    or (annulled_at is not null and annulled_by is not null and superseded_at is not null and length(btrim(annulment_reason)) between 1 and 500));

create or replace function clinical_private.guard_record() returns trigger
language plpgsql set search_path = pg_catalog as $$
declare
  field text;
  allowed text[];
  original clinical_private.records;
  archive clinical_private.ct_archives;
begin
  if tg_op = 'UPDATE' and old.status = 'published' then
    if (to_jsonb(new) - 'superseded_at' - 'annulled_at' - 'annulled_by' - 'annulment_reason')
      is distinct from (to_jsonb(old) - 'superseded_at' - 'annulled_at' - 'annulled_by' - 'annulment_reason')
      or old.superseded_at is not null or new.superseded_at is null then
      raise exception 'Published records are immutable' using errcode = '42501';
    end if;
    return new;
  end if;
  -- An annulled draft keeps its content for the audit trail and is not validated again.
  if tg_op = 'UPDATE' and new.annulled_at is not null and old.annulled_at is null then return new; end if;
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

create function clinical_private.annul_record(p_record uuid, p_reason text, p_confirm text) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  actor uuid := clinical_private.live_actor();
  n integer;
  rec clinical_private.records;
  archive clinical_private.ct_archives;
  reason text := btrim(coalesce(p_reason, ''));
begin
  if not clinical_private.portal_assurance_sufficient() then
    raise exception 'Staff authentication required' using errcode = '42501';
  end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  if p_confirm is distinct from 'Ta bort' or length(reason) not between 1 and 500 then
    raise exception 'Confirmation and reason required' using errcode = '22023';
  end if;
  select * into rec from clinical_private.records r where r.id = p_record for update;
  if rec.id is null or clinical_private.ct_archive_organization(actor, rec.patient_id) is distinct from rec.organization_id then
    raise exception 'Record unavailable' using errcode = '42501';
  end if;
  if rec.status = 'published' and not exists (select 1 from clinical_private.staff s
    where s.user_id = actor and s.organization_id = rec.organization_id and s.active and s.role = 'doctor') then
    raise exception 'A doctor must remove published records' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(rec.patient_id::text, 0));
  if rec.annulled_at is null then
    if rec.superseded_at is not null then raise exception 'Record is no longer current' using errcode = '40001'; end if;
    update clinical_private.records set superseded_at = now(), annulled_at = now(), annulled_by = actor, annulment_reason = reason
    where id = rec.id;
    insert into clinical_private.audit (actor_id, patient_id, action, record_id) values (actor, rec.patient_id, 'record.annul', rec.id);
  end if;
  if rec.kind = 'imaging' and rec.payload ? 'archiveId' then
    select * into archive from clinical_private.ct_archives a where a.id = (rec.payload->>'archiveId')::uuid
      and a.patient_id = rec.patient_id and a.organization_id = rec.organization_id for update;
    if archive.id is not null then
      if archive.removed_at is null then
        update clinical_private.ct_archives a set removed_at = now(), removed_by = actor, removal_reason = reason where a.id = archive.id;
        insert into clinical_private.audit (actor_id, patient_id, action, record_id) values (actor, rec.patient_id, 'record.remove_ct_archive', rec.id);
      end if;
      return jsonb_build_object('ok', true, 'path', archive.object_name);
    end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function clinical_private.annul_record(uuid, text, text) from public, anon, authenticated;
grant execute on function clinical_private.annul_record(uuid, text, text) to authenticated;
create function public.clinician_annul_record(p_record uuid, p_reason text, p_confirm text) returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.annul_record(p_record, p_reason, p_confirm)$$;
revoke all on function public.clinician_annul_record(uuid, text, text) from public, anon;
grant execute on function public.clinician_annul_record(uuid, text, text) to authenticated;
