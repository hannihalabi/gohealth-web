-- postgres already owns the imaging tables and has ADMIN OPTION on these roles.
-- Allow the owner to assume the restricted roles for RLS regression tests.
-- No application role or user receives membership; implicit inheritance stays disabled.
GRANT gohealth_imaging_api, gohealth_imaging_worker TO postgres WITH SET TRUE, INHERIT FALSE;
