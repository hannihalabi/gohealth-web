-- Hosted Storage 1.96 uses the legacy authenticated-read operation for GET.
alter policy patient_published_ct_archive_download on storage.objects using (
  bucket_id = 'clinical-ct-archives'
  and (select storage.allow_any_operation(array['object.get_authenticated', 'object.get_authenticated_info']))
  and clinical_private.patient_ct_archive_download_access(name, version)
);
