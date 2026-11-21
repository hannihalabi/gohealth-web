-- GoHealth imaging catalog. Additive migration; no clinical data is seeded.

CREATE TABLE imaging_admins (
	user_id UUID NOT NULL, 
	PRIMARY KEY (user_id)
);

CREATE TABLE imaging_audit (
	id UUID NOT NULL, 
	actor_id UUID NOT NULL, 
	action VARCHAR(64) NOT NULL, 
	resource_id VARCHAR(128) NOT NULL, 
	created_at VARCHAR(64) NOT NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_imaging_audit_actor_id ON imaging_audit (actor_id);

CREATE TABLE imaging_patients (
	id UUID NOT NULL, 
	owner_id UUID NOT NULL, 
	identity_verified BOOLEAN NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (owner_id)
);

CREATE TABLE imaging_imports (
	id UUID NOT NULL, 
	patient_id UUID NOT NULL, 
	actor_id UUID NOT NULL, 
	idempotency_key VARCHAR(128) NOT NULL, 
	status VARCHAR(32) NOT NULL, 
	detail VARCHAR(256) NOT NULL, 
	file_key VARCHAR(128) NOT NULL, 
	study_ids JSON NOT NULL, 
	created_at VARCHAR(64) NOT NULL, 
	updated_at VARCHAR(64) NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (actor_id, idempotency_key), 
	FOREIGN KEY(patient_id) REFERENCES imaging_patients (id)
);

CREATE INDEX ix_imaging_imports_patient_id ON imaging_imports (patient_id);

CREATE TABLE imaging_studies (
	id UUID NOT NULL, 
	patient_id UUID NOT NULL, 
	study_uid VARCHAR(128) NOT NULL, 
	description VARCHAR(256) NOT NULL, 
	study_date VARCHAR(32) NOT NULL, 
	modality VARCHAR(16) NOT NULL, 
	synthetic BOOLEAN NOT NULL, 
	created_at VARCHAR(64) NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (patient_id, study_uid), 
	FOREIGN KEY(patient_id) REFERENCES imaging_patients (id)
);

CREATE INDEX ix_imaging_studies_patient_id ON imaging_studies (patient_id);

CREATE TABLE imaging_series (
	id UUID NOT NULL, 
	study_id UUID NOT NULL, 
	series_uid VARCHAR(128) NOT NULL, 
	description VARCHAR(256) NOT NULL, 
	modality VARCHAR(16) NOT NULL, 
	frame_of_reference_uid VARCHAR(128) NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (study_id, series_uid), 
	FOREIGN KEY(study_id) REFERENCES imaging_studies (id)
);

CREATE INDEX ix_imaging_series_study_id ON imaging_series (study_id);

CREATE TABLE imaging_analysis_jobs (
	id UUID NOT NULL, 
	patient_id UUID NOT NULL, 
	series_id UUID NOT NULL, 
	status VARCHAR(32) NOT NULL, 
	input_manifest JSON NOT NULL, 
	model_version VARCHAR(128), 
	result JSON, 
	created_at VARCHAR(64) NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(patient_id) REFERENCES imaging_patients (id), 
	FOREIGN KEY(series_id) REFERENCES imaging_series (id)
);

CREATE INDEX ix_imaging_analysis_jobs_series_id ON imaging_analysis_jobs (series_id);

CREATE TABLE imaging_frames (
	id UUID NOT NULL, 
	series_id UUID NOT NULL, 
	sop_uid VARCHAR(128) NOT NULL, 
	frame_index INTEGER NOT NULL, 
	position JSON NOT NULL, 
	orientation JSON NOT NULL, 
	spacing JSON NOT NULL, 
	rows INTEGER NOT NULL, 
	columns INTEGER NOT NULL, 
	sort_position FLOAT NOT NULL, 
	window_center FLOAT NOT NULL, 
	window_width FLOAT NOT NULL, 
	object_key VARCHAR(128) NOT NULL, 
	sha256 VARCHAR(64) NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (series_id, sop_uid, frame_index), 
	FOREIGN KEY(series_id) REFERENCES imaging_series (id)
);

CREATE INDEX ix_imaging_frames_series_id ON imaging_frames (series_id);

CREATE INDEX ix_imaging_frames_sort_position ON imaging_frames (sort_position);

ALTER TABLE public.imaging_patients ADD CONSTRAINT imaging_patients_owner_auth_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id);
ALTER TABLE public.imaging_admins ADD CONSTRAINT imaging_admins_user_auth_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
CREATE INDEX imaging_analysis_patient_idx ON public.imaging_analysis_jobs(patient_id);
CREATE INDEX imaging_import_actor_idx ON public.imaging_imports(actor_id);
CREATE INDEX imaging_import_queue_idx ON public.imaging_imports(status, created_at);
CREATE INDEX imaging_study_patient_date_idx ON public.imaging_studies(patient_id, created_at DESC);

DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='gohealth_imaging_api') THEN
  CREATE ROLE gohealth_imaging_api NOLOGIN NOINHERIT NOBYPASSRLS;
 END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='gohealth_imaging_worker') THEN
  CREATE ROLE gohealth_imaging_worker NOLOGIN NOINHERIT NOBYPASSRLS;
 END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS imaging_private;
REVOKE ALL ON SCHEMA imaging_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA public, imaging_private, auth TO gohealth_imaging_api, gohealth_imaging_worker;
GRANT USAGE ON SCHEMA imaging_private TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO gohealth_imaging_api, gohealth_imaging_worker;

CREATE FUNCTION imaging_private.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.imaging_admins WHERE user_id=(SELECT auth.uid()));
$$;
CREATE FUNCTION imaging_private.can_read_patient(patient uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.imaging_patients p WHERE p.id=patient AND (p.owner_id=(SELECT auth.uid()) OR imaging_private.is_admin()));
$$;
CREATE FUNCTION imaging_private.can_read_study(study uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.imaging_studies s WHERE s.id=study AND imaging_private.can_read_patient(s.patient_id));
$$;
CREATE FUNCTION imaging_private.can_read_series(series uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.imaging_series s WHERE s.id=series AND imaging_private.can_read_study(s.study_id));
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA imaging_private FROM PUBLIC, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA imaging_private TO authenticated, gohealth_imaging_api, gohealth_imaging_worker;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['imaging_patients','imaging_admins','imaging_studies','imaging_series','imaging_frames','imaging_imports','imaging_analysis_jobs','imaging_audit'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated',t);
 END LOOP;
END $$;

GRANT SELECT ON public.imaging_patients, public.imaging_studies, public.imaging_series, public.imaging_frames, public.imaging_imports, public.imaging_analysis_jobs TO authenticated;
GRANT SELECT ON public.imaging_admins TO gohealth_imaging_api;
GRANT SELECT, INSERT, UPDATE ON public.imaging_patients, public.imaging_imports, public.imaging_analysis_jobs TO gohealth_imaging_api;
GRANT SELECT ON public.imaging_studies, public.imaging_series, public.imaging_frames TO gohealth_imaging_api;
GRANT INSERT ON public.imaging_audit TO gohealth_imaging_api;
GRANT SELECT ON public.imaging_admins, public.imaging_patients TO gohealth_imaging_worker;
GRANT SELECT, INSERT, UPDATE ON public.imaging_studies, public.imaging_series, public.imaging_frames, public.imaging_imports, public.imaging_analysis_jobs TO gohealth_imaging_worker;
GRANT INSERT ON public.imaging_audit TO gohealth_imaging_worker;

CREATE POLICY patient_read ON public.imaging_patients FOR SELECT TO authenticated, gohealth_imaging_api USING (owner_id=(SELECT auth.uid()) OR imaging_private.is_admin());
CREATE POLICY patient_create ON public.imaging_patients FOR INSERT TO gohealth_imaging_api WITH CHECK (imaging_private.is_admin());
CREATE POLICY patient_update ON public.imaging_patients FOR UPDATE TO gohealth_imaging_api USING (imaging_private.is_admin()) WITH CHECK (imaging_private.is_admin());
CREATE POLICY admin_self ON public.imaging_admins FOR SELECT TO gohealth_imaging_api USING (user_id=(SELECT auth.uid()));
CREATE POLICY study_read ON public.imaging_studies FOR SELECT TO authenticated, gohealth_imaging_api USING (imaging_private.can_read_patient(patient_id));
CREATE POLICY series_read ON public.imaging_series FOR SELECT TO authenticated, gohealth_imaging_api USING (imaging_private.can_read_study(study_id));
CREATE POLICY frame_read ON public.imaging_frames FOR SELECT TO authenticated, gohealth_imaging_api USING (imaging_private.can_read_series(series_id));
CREATE POLICY import_read ON public.imaging_imports FOR SELECT TO authenticated, gohealth_imaging_api USING (imaging_private.can_read_patient(patient_id));
CREATE POLICY import_create ON public.imaging_imports FOR INSERT TO gohealth_imaging_api WITH CHECK (imaging_private.is_admin() AND actor_id=(SELECT auth.uid()));
CREATE POLICY import_update ON public.imaging_imports FOR UPDATE TO gohealth_imaging_api USING (imaging_private.is_admin()) WITH CHECK (imaging_private.is_admin());
CREATE POLICY analysis_read ON public.imaging_analysis_jobs FOR SELECT TO authenticated, gohealth_imaging_api USING (imaging_private.can_read_patient(patient_id));
CREATE POLICY analysis_create ON public.imaging_analysis_jobs FOR INSERT TO gohealth_imaging_api WITH CHECK (imaging_private.can_read_patient(patient_id) AND status='awaiting_model' AND model_version IS NULL AND result IS NULL);
CREATE POLICY audit_append ON public.imaging_audit FOR INSERT TO gohealth_imaging_api WITH CHECK (actor_id=(SELECT auth.uid()));
CREATE POLICY audit_worker_append ON public.imaging_audit FOR INSERT TO gohealth_imaging_worker WITH CHECK (true);
CREATE POLICY patient_worker_read ON public.imaging_patients FOR SELECT TO gohealth_imaging_worker USING (true);
CREATE POLICY admin_worker_read ON public.imaging_admins FOR SELECT TO gohealth_imaging_worker USING (true);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['imaging_studies','imaging_series','imaging_frames','imaging_imports','imaging_analysis_jobs'] LOOP
  EXECUTE format('CREATE POLICY worker_access ON public.%I FOR ALL TO gohealth_imaging_worker USING (true) WITH CHECK (true)',t);
 END LOOP;
END $$;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('imaging-originals','imaging-originals',false,67108864,ARRAY['application/dicom','application/octet-stream']),
       ('imaging-imports','imaging-imports',false,268435456,ARRAY['application/zip','application/dicom','application/octet-stream'])
ON CONFLICT(id) DO NOTHING;
-- Deliberately no public object or anonymous storage policies. Original files are private.
