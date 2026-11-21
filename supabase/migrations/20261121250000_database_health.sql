-- Database health for administrators: load, connections, cache efficiency and size. Aggregates only, never query text or row data.
create function clinical_private.database_health(org uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  actor uuid := clinical_private.live_actor();
  n integer;
  conn record;
  stat record;
  top jsonb;
  storage_objects bigint := 0;
  storage_bytes bigint := 0;
  user_count bigint := 0;
  last_migration text;
begin
  if not clinical_private.portal_assurance_sufficient() or not exists (
    select 1 from clinical_private.administrators where user_id = actor and organization_id = org and active
  ) then raise exception 'Administrator required' using errcode = '42501'; end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;

  select count(*)::int as used,
    count(*) filter (where state = 'active')::int as active,
    count(*) filter (where state = 'idle')::int as idle,
    count(*) filter (where state like 'idle in transaction%')::int as idle_tx,
    coalesce(max(extract(epoch from now() - xact_start)) filter (where xact_start is not null and pid <> pg_backend_pid()), 0)::int as longest
  into conn from pg_stat_activity where datname = current_database() and backend_type = 'client backend';
  select xact_commit, xact_rollback, blks_read, blks_hit, deadlocks, temp_bytes, stats_reset
  into stat from pg_stat_database where datname = current_database();
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into top from (
    select schemaname || '.' || relname as name, pg_total_relation_size(relid) as size_bytes, n_live_tup as live_rows, n_dead_tup as dead_rows
    from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 5) t;
  begin
    select count(*), coalesce(sum((metadata->>'size')::bigint), 0) into storage_objects, storage_bytes from storage.objects;
  exception when others then storage_objects := 0; storage_bytes := 0; end;
  begin select count(*) into user_count from auth.users; exception when others then user_count := 0; end;
  begin execute 'select max(version) from supabase_migrations.schema_migrations' into last_migration; exception when others then last_migration := null; end;

  return jsonb_build_object(
    'checkedAt', now(),
    'version', current_setting('server_version'),
    'startedAt', pg_postmaster_start_time(),
    'connections', jsonb_build_object('used', conn.used, 'max', current_setting('max_connections')::int, 'active', conn.active,
      'idle', conn.idle, 'idleInTransaction', conn.idle_tx, 'longestTransactionSeconds', conn.longest),
    'database', jsonb_build_object('sizeBytes', pg_database_size(current_database()),
      'tables', (select count(*) from pg_stat_user_tables),
      'commits', stat.xact_commit, 'rollbacks', stat.xact_rollback, 'blocksRead', stat.blks_read, 'blocksHit', stat.blks_hit,
      'deadlocks', stat.deadlocks, 'tempBytes', stat.temp_bytes, 'statsReset', stat.stats_reset),
    'topTables', top,
    'storage', jsonb_build_object('objects', storage_objects, 'bytes', storage_bytes),
    'users', user_count,
    'lastMigration', last_migration);
end $$;
revoke all on function clinical_private.database_health(uuid) from public, anon, authenticated;
grant execute on function clinical_private.database_health(uuid) to authenticated;
create function public.clinician_database_health(p_organization_id uuid) returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.database_health(p_organization_id)$$;
revoke all on function public.clinician_database_health(uuid) from public, anon;
grant execute on function public.clinician_database_health(uuid) to authenticated;
