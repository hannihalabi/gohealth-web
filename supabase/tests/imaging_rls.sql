-- Run as project administrator. Every synthetic fixture is rolled back; no auth emails or patient data.
BEGIN;
INSERT INTO auth.users(id, email, aud, role) VALUES
 ('a0010000-0000-4000-8000-000000000001','imaging-rls-one@example.invalid','authenticated','authenticated'),
 ('a0010000-0000-4000-8000-000000000002','imaging-rls-two@example.invalid','authenticated','authenticated');
INSERT INTO public.imaging_patients(id,owner_id,identity_verified) VALUES
 ('a0020000-0000-4000-8000-000000000001','a0010000-0000-4000-8000-000000000001',true),
 ('a0020000-0000-4000-8000-000000000002','a0010000-0000-4000-8000-000000000002',true);
INSERT INTO public.imaging_studies(id,patient_id,study_uid,description,study_date,modality,synthetic,created_at) VALUES
 ('a0030000-0000-4000-8000-000000000001','a0020000-0000-4000-8000-000000000001','1.2.991.1','RLS test one','','CT',true,'2000-01-01T00:00:00+00:00'),
 ('a0030000-0000-4000-8000-000000000002','a0020000-0000-4000-8000-000000000002','1.2.991.2','RLS test two','','CT',true,'2000-01-01T00:00:00+00:00');
SET LOCAL ROLE gohealth_imaging_api;
SELECT set_config('request.jwt.claims','{"sub":"a0010000-0000-4000-8000-000000000001","role":"authenticated"}',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.imaging_patients) <> 1 THEN RAISE EXCEPTION 'Patient isolation failed'; END IF;
 IF (SELECT count(*) FROM public.imaging_studies) <> 1 THEN RAISE EXCEPTION 'Study isolation failed'; END IF;
 IF EXISTS(SELECT 1 FROM public.imaging_studies WHERE id='a0030000-0000-4000-8000-000000000002') THEN RAISE EXCEPTION 'Cross-user read allowed'; END IF;
 BEGIN
  INSERT INTO public.imaging_admins(user_id) VALUES('a0010000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'Privilege escalation allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  UPDATE public.imaging_audit SET action='altered';
  RAISE EXCEPTION 'Audit mutation allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$ BEGIN
 BEGIN
  PERFORM 1 FROM public.imaging_studies;
  RAISE EXCEPTION 'Unaudited PostgREST read allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$ BEGIN
 BEGIN
  PERFORM 1 FROM public.imaging_frames;
  RAISE EXCEPTION 'Anonymous image access allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE gohealth_imaging_worker;
DO $$ BEGIN
 IF (SELECT count(*) FROM public.imaging_patients) <> 2 THEN RAISE EXCEPTION 'Worker scope failed'; END IF;
 BEGIN
  DELETE FROM public.imaging_admins;
  RAISE EXCEPTION 'Worker admin mutation allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
ROLLBACK;
