-- Execute inside a transaction and roll back. Synthetic accounts only.
create function pg_temp.dh_assert(condition boolean, label text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'Failed: %', label; end if; end $$;
create function pg_temp.dh_denied(statement text, state text, label text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'Unexpected success: %', label;
exception when others then
  if sqlstate is distinct from state then raise; end if;
end $$;
create function pg_temp.dh_claims(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'b6000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'session_id', 'b7000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'aal', 'aal1', 'amr', jsonb_build_array(jsonb_build_object('method', 'password')))::text, true);
end $$;
update clinical_private.portal_settings set mfa_required = false;
insert into auth.users(id, email, email_confirmed_at)
select ('b6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'health-' || n || '@example.invalid', now() from generate_series(1, 2) n;
insert into auth.sessions(id, user_id)
select ('b7000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ('b6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid from generate_series(1, 2) n;
insert into clinical_private.organizations(id, name) values ('b8000000-0000-4000-8000-000000000001', 'Health clinic'), ('b8000000-0000-4000-8000-000000000002', 'Other clinic');
insert into clinical_private.administrators(user_id, organization_id, display_name)
values ('b6000000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000001', 'Admin');
insert into clinical_private.staff(user_id, organization_id, display_name, role)
values ('b6000000-0000-4000-8000-000000000002', 'b8000000-0000-4000-8000-000000000001', 'Doctor', 'doctor');

set local role authenticated;
select pg_temp.dh_claims(1);
select pg_temp.dh_assert(
  (select (r->'connections'->>'max')::int > 0 and (r->'connections'->>'used')::int >= 0 and r ? 'database' and r ? 'topTables' and r ? 'storage' and r->'database' ? 'blocksHit'
   from (select public.clinician_database_health('b8000000-0000-4000-8000-000000000001') r) x), 'an administrator receives the health overview');
select pg_temp.dh_assert(not (public.clinician_database_health('b8000000-0000-4000-8000-000000000001')::text ~* 'select |insert |query'), 'no query text is exposed');
select pg_temp.dh_denied($q$select public.clinician_database_health('b8000000-0000-4000-8000-000000000002')$q$, '42501', 'an administrator of another clinic is denied');
select pg_temp.dh_claims(2);
select pg_temp.dh_denied($q$select public.clinician_database_health('b8000000-0000-4000-8000-000000000001')$q$, '42501', 'a clinician without administrator rights is denied');
reset role;
set local role anon;
select pg_temp.dh_denied($q$select public.clinician_database_health('b8000000-0000-4000-8000-000000000001')$q$, '42501', 'anonymous callers are denied');
reset role;
select 'Database health tests passed: administrator-only, clinic scoped, aggregates without query text.' as result;
