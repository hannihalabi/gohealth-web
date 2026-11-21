-- Restrict only the six empty imaging tables created by this task.
-- Verified zero patients, admins, studies, series, frames, imports, analyses and audit rows.
-- iOS RadiologyAPI calls /v1 on a separate server and never queries PostgREST.
-- Dedicated API/worker grants and every existing auth/storage object remain unchanged.
REVOKE SELECT ON public.imaging_patients, public.imaging_studies,
 public.imaging_series, public.imaging_frames, public.imaging_imports,
 public.imaging_analysis_jobs FROM authenticated;
