-- Defense in depth for null-valued SQL checks and immutable published records.
-- Filename version matches the applied GoHealth Dev migration history.
alter table clinical_private.records add constraint correction_reason_required
check(replaces_id is null or (correction_reason is not null and length(btrim(correction_reason)) between 1 and 500));
alter table clinical_private.vitals add constraint pulse_value_required
check(kind='sleep' or value is not null);

create function clinical_private.guard_record() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare field text; allowed text[]; original clinical_private.records;
begin
  if tg_op='UPDATE' and old.status='published' then
    if (to_jsonb(new)-'superseded_at') is distinct from (to_jsonb(old)-'superseded_at')
      or old.superseded_at is not null or new.superseded_at is null then
      raise exception 'Published records are immutable' using errcode='42501';
    end if;
    return new;
  end if;
  perform clinical_private.validate_payload(new.kind,new.payload);
  if new.payload->>'sampledAt' !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then raise exception 'Timezone required' using errcode='22023';end if;
  allowed:=array['title','sampledAt','source','comment'];
  if new.kind='lab' then allowed:=allowed||array['observations'];
  elsif new.kind='vaccination' then allowed:=allowed||array['vaccine','dose','batch','location'];
  else
    allowed:=allowed||array['modality','bodyPart','conclusion','studyId'];
    foreach field in array array['modality','bodyPart','conclusion','studyId'] loop
      if jsonb_typeof(new.payload->field) is distinct from 'string' then raise exception 'Text field required' using errcode='22023';end if;
    end loop;
  end if;
  if exists(select 1 from jsonb_object_keys(new.payload) k where not k=any(allowed)) then raise exception 'Unknown payload field' using errcode='22023';end if;
  if new.replaces_id is not null then
    select * into original from clinical_private.records where id=new.replaces_id;
    if original.patient_id is distinct from new.patient_id or original.organization_id is distinct from new.organization_id
      or original.kind is distinct from new.kind or original.status<>'published' or original.version+1<>new.version then
      raise exception 'Invalid correction lineage' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function clinical_private.guard_record() from public,anon,authenticated;
create trigger guard_clinical_record before insert or update on clinical_private.records
for each row execute function clinical_private.guard_record();
