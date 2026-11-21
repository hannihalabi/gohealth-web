-- Execute inside a transaction and roll back. Only synthetic Storage metadata is used.
create function pg_temp.ct_assert(condition boolean, label text) returns void language plpgsql as $$
begin
  if condition is distinct from true then raise exception 'Failed: %', label; end if;
end $$;
create function pg_temp.ct_denied(statement text, state text, label text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'Unexpected success: %', label;
exception when others then
  if sqlstate is distinct from state then raise; end if;
end $$;
create function pg_temp.ct_claims(n integer, method text default 'password') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', '91000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'session_id', '92000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'aal', 'aal1', 'amr', jsonb_build_array(jsonb_build_object('method', method)))::text, true);
end $$;
create function pg_temp.ct_payload(archive_id text) returns jsonb language sql as $$
  select jsonb_build_object('title', 'Synthetic CT', 'source', 'Synthetic', 'sampledAt', '2025-01-01T12:00:00Z',
    'comment', '', 'modality', 'CT', 'bodyPart', 'Synthetic', 'conclusion', 'Synthetic', 'studyId', '', 'archiveId', archive_id)
$$;

update clinical_private.portal_settings set mfa_required = false;
insert into auth.users(id, email, email_confirmed_at)
select ('91000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'synthetic-ct-' || n || '@example.invalid', now()
from generate_series(1, 5) n;
insert into auth.sessions(id, user_id)
select ('92000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('91000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
from generate_series(1, 5) n;
insert into clinical_private.organizations(id, name) values ('93000000-0000-4000-8000-000000000001', 'Synthetic clinic');
insert into clinical_private.staff(user_id, organization_id, display_name, role)
select u.id, '93000000-0000-4000-8000-000000000001', 'Synthetic clinician', 'doctor'
from auth.users u where u.id in ('91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000003');
insert into clinical_private.patients(id, account_id, display_name, identity_label, identity_verified) values
  ('94000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000004', 'Synthetic patient', 'SYNTHETIC-CT-1', true),
  ('94000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000005', 'Another patient', 'SYNTHETIC-CT-2', true);
insert into clinical_private.assignments (patient_id, organization_id, clinician_id) values
  ('94000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001'),
  ('94000000-0000-4000-8000-000000000002', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001'),
  ('94000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002');

create temp table ct_fixture (label text primary key, value jsonb);
grant select, insert on ct_fixture to authenticated;
select pg_temp.ct_assert((select not public and file_size_limit = 52428800 and allowed_mime_types = array['application/zip']
  from storage.buckets where id = 'clinical-ct-archives'), 'private ZIP-only bucket');
select pg_temp.ct_assert(not has_function_privilege('anon', 'public.clinician_ct_archive(text,jsonb)', 'execute'), 'anonymous RPC unavailable');

set local role authenticated;
select pg_temp.ct_claims(3);
select pg_temp.ct_denied($q$select public.clinician_ct_archive('begin', '{"patientId":"94000000-0000-4000-8000-000000000001","size":100}')$q$,
  '42501', 'unassigned clinician cannot upload');
select pg_temp.ct_claims(1, 'otp');
select pg_temp.ct_denied($q$select public.clinician_ct_archive('begin', '{"patientId":"94000000-0000-4000-8000-000000000001","size":100}')$q$,
  '42501', 'password beta still requires proper staff authentication');
select pg_temp.ct_claims(1);
select pg_temp.ct_denied($q$select public.clinician_ct_archive('begin', '{"patientId":"94000000-0000-4000-8000-000000000001","size":52428801}')$q$,
  '22023', 'oversized archive');
insert into ct_fixture select 'initial', public.clinician_ct_archive('begin', '{"patientId":"94000000-0000-4000-8000-000000000001","size":33554432}');
select pg_temp.ct_denied(format('select public.clinician_ct_archive(''finish'', %L)',
  jsonb_build_object('id', value->>'id', 'imageCount', 500)), '22023', 'finalization requires uploaded object')
from ct_fixture where label = 'initial';
select pg_temp.ct_denied(format($q$select public.clinician_save_record('94000000-0000-4000-8000-000000000001','imaging',pg_temp.ct_payload(%L),null,0,null,'')$q$, value->>'id'),
  '42501', 'unvalidated upload cannot be attached') from ct_fixture where label = 'initial';

-- The signed upload permission probe uses contentLength; real object metadata uses size.
select pg_temp.ct_assert(clinical_private.ct_archive_object_access(value->>'path', 'probe', 'insert'), 'owner may sign an upload')
from ct_fixture where label = 'initial';
select pg_temp.ct_claims(2);
select pg_temp.ct_assert(not clinical_private.ct_archive_object_access(value->>'path', 'probe', 'insert'), 'colleague cannot sign another uploader reservation')
from ct_fixture where label = 'initial';
reset role;
select pg_temp.ct_denied(format('insert into storage.objects(bucket_id,name,version,metadata) values (''clinical-ct-archives'', %L, ''1'', ''{"size":1,"mimetype":"application/zip"}'')', value->>'path'),
  '42501', 'Storage write itself checks reservation size') from ct_fixture where label = 'initial';
insert into storage.objects(bucket_id,name,version,metadata)
select 'clinical-ct-archives', value->>'path', 'initial-version', '{"size":33554432,"mimetype":"application/zip"}'
from ct_fixture where label = 'initial';
select pg_temp.ct_denied(format('update storage.objects set version = ''changed-version'' where bucket_id = ''clinical-ct-archives'' and name = %L', value->>'path'),
  '42501', 'privileged Storage completion cannot overwrite an existing archive') from ct_fixture where label = 'initial';

set local role authenticated;
select pg_temp.ct_claims(2);
select pg_temp.ct_assert(not exists (select 1 from storage.objects where bucket_id='clinical-ct-archives'), 'colleague cannot fetch staged bytes');
select pg_temp.ct_claims(1);
select pg_temp.ct_assert((select count(*) = 1 from storage.objects where bucket_id='clinical-ct-archives'), 'uploader can fetch staged bytes');
select pg_temp.ct_assert((public.clinician_ct_archive('inspect', jsonb_build_object('id', value->>'id'))->>'size')::int = 33554432,
  'uploader may inspect the committed object') from ct_fixture where label = 'initial';
select pg_temp.ct_assert((public.clinician_ct_archive('finish', jsonb_build_object('id', value->>'id', 'imageCount', 500))->>'imageCount')::int = 500,
  'finalization records the image count') from ct_fixture where label = 'initial';
select pg_temp.ct_assert((public.clinician_ct_archive('finish', jsonb_build_object('id', value->>'id', 'imageCount', 1))->>'imageCount')::int = 500,
  'retries preserve finalized count') from ct_fixture where label = 'initial';
select pg_temp.ct_denied(format($q$select public.clinician_save_record('94000000-0000-4000-8000-000000000002','imaging',pg_temp.ct_payload(%L),null,0,null,'')$q$, value->>'id'),
  '42501', 'same clinician cannot attach an archive to another assigned patient') from ct_fixture where label = 'initial';
select pg_temp.ct_claims(2);
select pg_temp.ct_denied(format($q$select public.clinician_save_record('94000000-0000-4000-8000-000000000001','imaging',pg_temp.ct_payload(%L),null,0,null,'')$q$, value->>'id'),
  '42501', 'colleague cannot claim an unattached finalized archive') from ct_fixture where label = 'initial';
select pg_temp.ct_claims(1);
insert into ct_fixture select 'record', public.clinician_save_record('94000000-0000-4000-8000-000000000001',
  'imaging', pg_temp.ct_payload(value->>'id'), null, 0, null, '') from ct_fixture where label = 'initial';
select pg_temp.ct_denied(format('select public.clinician_ct_archive(''cancel'', %L)', jsonb_build_object('id', value->>'id')),
  '42501', 'attached archives cannot be cancelled') from ct_fixture where label = 'initial';
select pg_temp.ct_denied(format($q$select public.clinician_save_record('94000000-0000-4000-8000-000000000001','imaging',pg_temp.ct_payload(%L),null,0,null,'')$q$, value->>'id'),
  '42501', 'archive cannot attach to an unrelated record') from ct_fixture where label = 'initial';

select pg_temp.ct_claims(4, 'otp');
select set_config('storage.operation', 'storage.object.get_authenticated', true);
select pg_temp.ct_assert(not exists (select 1 from storage.objects where bucket_id='clinical-ct-archives'), 'patient cannot fetch draft bytes');
select pg_temp.ct_assert(public.gohealth_patient_data()->'records' = '[]'::jsonb, 'patient receives no draft metadata');
select set_config('storage.operation', '', true);
select pg_temp.ct_claims(1);
select public.clinician_publish_record((value->>'id')::uuid, 1) from ct_fixture where label = 'record';

select pg_temp.ct_claims(2);
select pg_temp.ct_assert((public.clinician_ct_archive('read', jsonb_build_object('recordId', value->>'id'))->>'imageCount')::int = 500,
  'assigned colleague can download an attached archive') from ct_fixture where label = 'record';
select pg_temp.ct_assert((select count(*) = 1 from storage.objects where bucket_id='clinical-ct-archives'), 'attached object is visible to the care team');
insert into ct_fixture select 'correction', public.clinician_save_record('94000000-0000-4000-8000-000000000001', 'imaging',
  value->'payload', null, 0, (value->>'id')::uuid, 'Synthetic correction') from ct_fixture where label = 'record';
select public.clinician_publish_record((value->>'id')::uuid, 1) from ct_fixture where label = 'correction';

select pg_temp.ct_claims(3);
select pg_temp.ct_denied(format('select public.clinician_ct_archive(''read'', %L)', jsonb_build_object('recordId', value->>'id')),
  '42501', 'unassigned clinician cannot request download') from ct_fixture where label = 'record';
select pg_temp.ct_assert(not exists (select 1 from storage.objects where bucket_id='clinical-ct-archives'), 'unassigned clinician cannot fetch attached bytes');
select pg_temp.ct_claims(4, 'otp');
select pg_temp.ct_assert((public.gohealth_patient_data()->'records'->0->'payload'->>'title') = 'Synthetic CT', 'patient still sees the report');
select pg_temp.ct_assert(not (public.gohealth_patient_data()->'records'->0->'payload' ? 'archiveId'), 'patient payload omits the internal archive reference');
select pg_temp.ct_assert(public.gohealth_patient_data()->'records'->0->'image_archive' =
  jsonb_build_object('id', value->>'id', 'size', 33554432, 'imageCount', 500),
  'current correction exposes metadata when it keeps the archive') from ct_fixture where label = 'initial';
select pg_temp.ct_assert(not exists (select 1 from storage.objects where bucket_id='clinical-ct-archives'), 'patient cannot select storage outside authenticated download');
select set_config('storage.operation', 'storage.object.list', true);
select pg_temp.ct_assert(not exists (select 1 from storage.objects where bucket_id='clinical-ct-archives'), 'patient cannot list archives');
select set_config('storage.operation', 'storage.object.sign', true);
select pg_temp.ct_assert(not exists (select 1 from storage.objects where bucket_id='clinical-ct-archives'), 'patient cannot sign an archive URL');
select set_config('storage.operation', 'storage.object.get_authenticated', true);
select pg_temp.ct_assert(exists (select 1 from storage.objects where bucket_id='clinical-ct-archives' and name = value->>'path'),
  'verified owner may download their current published archive') from ct_fixture where label = 'initial';
select set_config('storage.operation', 'object.get_authenticated_info', true);
select pg_temp.ct_assert(exists (select 1 from storage.objects where bucket_id='clinical-ct-archives' and name = value->>'path'),
  'hosted authenticated GET operation allows the verified owner') from ct_fixture where label = 'initial';
select pg_temp.ct_claims(5, 'otp');
select pg_temp.ct_assert(not exists (select 1 from storage.objects where bucket_id='clinical-ct-archives'), 'another verified patient cannot download');
select pg_temp.ct_assert(public.gohealth_patient_data()->'records' = '[]'::jsonb, 'another patient receives no archive metadata');
select pg_temp.ct_claims(4, 'otp');
reset role;
set local role anon;
select pg_temp.ct_assert(not exists (select 1 from storage.objects where bucket_id='clinical-ct-archives'), 'anonymous download unavailable');
reset role;
select pg_temp.ct_assert(not has_function_privilege('anon', 'public.gohealth_patient_data()', 'execute'), 'anonymous patient API unavailable');

update auth.users set banned_until = now() + interval '1 day' where id = '91000000-0000-4000-8000-000000000004';
set local role authenticated;
select pg_temp.ct_assert(not exists (select 1 from storage.objects where bucket_id='clinical-ct-archives'), 'banned owner cannot download');
reset role;
update auth.users set banned_until = null where id = '91000000-0000-4000-8000-000000000004';
update auth.sessions set not_after = now() - interval '1 second' where id = '92000000-0000-4000-8000-000000000004';
set local role authenticated;
select pg_temp.ct_assert(not exists (select 1 from storage.objects where bucket_id='clinical-ct-archives'), 'expired session cannot download');
reset role;
delete from auth.sessions where id = '92000000-0000-4000-8000-000000000004';
set local role authenticated;
select pg_temp.ct_assert(not exists (select 1 from storage.objects where bucket_id='clinical-ct-archives'), 'revoked patient session cannot download');
select pg_temp.ct_denied('select public.gohealth_patient_data()', '42501', 'revoked patient session cannot read metadata');
reset role;
insert into auth.sessions(id, user_id) values ('92000000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-000000000004');
update clinical_private.patients set identity_verified = false where id = '94000000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.ct_assert(not exists (select 1 from storage.objects where bucket_id='clinical-ct-archives'), 'unverified owner cannot download');
reset role;
update clinical_private.patients set identity_verified = true where id = '94000000-0000-4000-8000-000000000001';

set local role authenticated;
select pg_temp.ct_claims(1);
insert into ct_fixture select 'without_archive', public.clinician_save_record('94000000-0000-4000-8000-000000000001', 'imaging',
  (value->'payload') - 'archiveId', null, 0, (value->>'id')::uuid, 'Synthetic correction without image archive')
from ct_fixture where label = 'correction';
select public.clinician_publish_record((value->>'id')::uuid, 1) from ct_fixture where label = 'without_archive';
select pg_temp.ct_claims(4, 'otp');
select pg_temp.ct_assert(not exists (select 1 from storage.objects where bucket_id='clinical-ct-archives'), 'superseded archive is removed from patient downloads');
select pg_temp.ct_assert(not (public.gohealth_patient_data()->'records'->0 ? 'image_archive'), 'current record without attachment omits the metadata field');
select set_config('storage.operation', '', true);

select pg_temp.ct_claims(1);
insert into ct_fixture select 'cancelled', public.clinician_ct_archive('begin', '{"patientId":"94000000-0000-4000-8000-000000000001","size":100}');
insert into storage.objects(bucket_id,name,version,metadata)
select 'clinical-ct-archives', value->>'path', 'cancelled-version', '{"size":100,"mimetype":"application/zip"}'
from ct_fixture where label = 'cancelled';
select public.clinician_ct_archive('cancel', jsonb_build_object('id', value->>'id')) from ct_fixture where label = 'cancelled';
select pg_temp.ct_assert(clinical_private.ct_archive_object_access(value->>'path', 'cancelled-version', 'delete'),
  'only the cancelled upload is eligible for cleanup') from ct_fixture where label = 'cancelled';
select pg_temp.ct_assert(not clinical_private.ct_archive_object_access(value->>'path', 'initial-version', 'delete'),
  'an attached archive cannot be removed') from ct_fixture where label = 'initial';
select pg_temp.ct_denied(format('select public.clinician_ct_archive(''finish'', %L)', jsonb_build_object('id', value->>'id', 'imageCount', 1)),
  '42501', 'cancelled archive cannot be finalized') from ct_fixture where label = 'cancelled';
insert into ct_fixture select 'revoked', public.clinician_ct_archive('begin', '{"patientId":"94000000-0000-4000-8000-000000000001","size":100}');
reset role;
delete from auth.sessions where id = '92000000-0000-4000-8000-000000000001';
select pg_temp.ct_denied(format('insert into storage.objects(bucket_id,name,version,metadata) values (''clinical-ct-archives'', %L, ''revoked-version'', ''{"size":100,"mimetype":"application/zip"}'')', value->>'path'),
  '42501', 'revoking the session prevents signed upload completion') from ct_fixture where label = 'revoked';
set local role authenticated;
select pg_temp.ct_claims(1);
select pg_temp.ct_assert(not exists (select 1 from storage.objects where bucket_id='clinical-ct-archives'), 'revoking the session prevents downloads');
reset role;
set constraints all immediate;
select 'CT archive tests passed: assignment boundaries, upload immutability, attachment lineage, cancellation, and authenticated patient downloads for current publications only.' as result;
