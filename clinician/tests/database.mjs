import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
const db = new PGlite();
try {
  await db.exec(`
    create role anon; create role authenticated;
    grant usage on schema public to authenticated;
    create schema auth;
    create table auth.users(id uuid primary key,banned_until timestamptz,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users,not_after timestamptz);
    create function auth.jwt() returns jsonb language sql as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth to authenticated;
    create table public.imaging_patients(id uuid primary key,owner_id uuid);
    create table public.imaging_studies(id uuid primary key,patient_id uuid);
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text not null references storage.buckets,
      name text not null,version text,metadata jsonb,unique(bucket_id,name));
    create function storage.allow_only_operation(expected text) returns boolean language sql stable as $$
      select coalesce(regexp_replace(current_setting('storage.operation', true), '^storage\\.', '') =
        regexp_replace(expected, '^storage\\.', ''), false)
    $$;
    create function storage.allow_any_operation(expected text[]) returns boolean language sql stable as $$
      select exists (select 1 from unnest(expected) operation where storage.allow_only_operation(operation))
    $$;
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated,anon;
    grant select,insert,update,delete on storage.objects to authenticated;
    grant select on storage.objects to anon;
  `);
  await db.exec(
    await readFile(
      new URL(
        "../../supabase/migrations/20261117201821_clinician_core.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    await readFile(
      new URL(
        "../../supabase/migrations/20261117202732_clinician_hardening.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    await readFile(
      new URL(
      "../../supabase/migrations/20261117220410_clinician_administration.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    await readFile(
      new URL(
        "../../supabase/migrations/20261118191702_clinician_portal_password_beta.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    await readFile(
      new URL(
        "../../supabase/migrations/20261121050333_clinician_ct_archives.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    await readFile(
      new URL(
        "../../supabase/migrations/20261121053854_patient_ct_archives.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(await readFile(new URL("../../supabase/migrations/20261121094015_patient_ct_archive_hosted_reads.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261121150339_clinician_step_sharing.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261121151020_administration_overview.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261121164034_all_health_history.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261121173959_care_teams_and_workload.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261121200000_patient_pipeline.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261121220000_imaging_images_and_removal.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261121230000_annul_records.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261121240000_pending_attestations.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261121250000_database_health.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261121260000_health_trend.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261122100000_patient_directory.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261122110000_integration_activity.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261121203559_automatic_health_sync.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261122120000_health_summary.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261122130000_health_read_paths.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261122140000_health_daily.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261123100000_clinician_overview.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261123110000_deviation_steps.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261123120000_patient_messages.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261123130000_message_poll.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261123140000_message_inbox.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261123150000_more_roles.sql", import.meta.url), "utf8"));
  for (const suite of ["clinician_core.sql","clinician_administration.sql","clinician_portal_password_beta.sql","clinician_ct_archives.sql","administration_overview.sql","health_history.sql","care_teams.sql","patient_pipeline.sql","record_annulment.sql","database_health.sql","health_trend.sql","patient_directory.sql","automatic_health_sync.sql","health_summary.sql","health_daily.sql","clinician_overview.sql","patient_messages.sql","more_roles.sql"]) {
    await db.exec("begin");
    const results = await db.exec(
      await readFile(
        new URL("../../supabase/tests/" + suite, import.meta.url),
        "utf8",
      ),
    );
    console.log(results.at(-1).rows);
    await db.exec("rollback");
  }
  const remaining = await db.query(
    "select count(*)::int as count from auth.users",
  );
  if (remaining.rows[0].count !== 0)
    throw new Error("Test accounts were not rolled back");
  console.log("Rollback verified: no test accounts remain.");
} catch (e) {
  console.error(e.message, e.detail || "", e.where || "");
  process.exitCode = 1;
} finally {
  await db.close();
}
