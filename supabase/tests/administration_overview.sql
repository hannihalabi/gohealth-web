-- Synthetic fixtures; always run inside BEGIN / ROLLBACK.
insert into auth.users(id,email,email_confirmed_at)
select ('91000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'overview-'||n||'@example.invalid',now() from generate_series(1,60)n;
insert into auth.sessions(id,user_id)
select ('92000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('91000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,4)n;
insert into clinical_private.organizations(id,name) values
 ('93000000-0000-4000-8000-000000000001','Overview A'),('93000000-0000-4000-8000-000000000002','Overview B');
insert into clinical_private.administrators(user_id,organization_id,display_name) values
 ('91000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001','Admin A'),
 ('91000000-0000-4000-8000-000000000003','93000000-0000-4000-8000-000000000002','Admin B');
insert into clinical_private.staff(user_id,organization_id,display_name,role)
select ('91000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 '93000000-0000-4000-8000-000000000001','Member '||lpad(n::text,3,'0'),'doctor'
from generate_series(2,60)n where n not in(3,4);
insert into clinical_private.staff(user_id,organization_id,display_name,role) values
 ('91000000-0000-4000-8000-000000000004','93000000-0000-4000-8000-000000000002','Private B','nurse');
create function pg_temp.overview_claims(n int,aal text default 'aal2',proof boolean default false) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claims',jsonb_build_object('sub','91000000-0000-4000-8000-'||lpad(n::text,12,'0'),'aal',aal,
 'session_id','92000000-0000-4000-8000-'||lpad(n::text,12,'0'),'amr',case when proof then '[{"method":"password"}]'::jsonb else '[]'::jsonb end)::text,true);
end$$;
create function pg_temp.overview_assert(ok boolean,label text) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'FAILED: %',label;end if;end$$;
create function pg_temp.overview_denied(q text,label text,expected text default '42501') returns void language plpgsql as $$begin
 begin execute q;exception when others then if sqlstate=expected then return;else raise exception 'WRONG ERROR % in %: %',sqlstate,label,sqlerrm;end if;end;
 raise exception 'UNEXPECTED SUCCESS: %',label;end$$;
select pg_temp.overview_claims(1);
set local role authenticated;
select pg_temp.overview_assert((public.clinician_system_overview('93000000-0000-4000-8000-000000000001')->>'memberTotal')::int=57,'exact total beyond one page');
select pg_temp.overview_assert(jsonb_array_length(public.clinician_system_overview('93000000-0000-4000-8000-000000000001')->'members')=50,'bounded first page');
select pg_temp.overview_assert(jsonb_array_length(public.clinician_system_overview('93000000-0000-4000-8000-000000000001','clinician',50)->'members')=7,'remaining page');
select pg_temp.overview_assert(not exists(select 1 from jsonb_array_elements(public.clinician_system_overview('93000000-0000-4000-8000-000000000001')->'members')m where m->>'email'='overview-4@example.invalid'),'other clinic identities hidden');
select pg_temp.overview_assert(jsonb_array_length(public.clinician_system_overview('93000000-0000-4000-8000-000000000001','admin')->'members')=1,'separate admin list');
select pg_temp.overview_assert(not (public.clinician_system_overview('93000000-0000-4000-8000-000000000001') ?| array['patients','records','assignments']),'no patient payload');
select pg_temp.overview_denied($q$select public.clinician_system_overview('93000000-0000-4000-8000-000000000002')$q$,'cross organisation');
select pg_temp.overview_denied('select * from clinical_private.system_integrations','no direct registry reads');
select pg_temp.overview_denied($q$update clinical_private.system_integrations set connected=true$q$,'no direct registry edits');
select pg_temp.overview_denied($q$select public.clinician_system_overview('93000000-0000-4000-8000-000000000001','owner')$q$,'reject invalid portal','22023');
select pg_temp.overview_denied($q$select public.clinician_system_overview('93000000-0000-4000-8000-000000000001','clinician',-1)$q$,'reject invalid offset','22023');
select pg_temp.overview_claims(2);
select pg_temp.overview_denied($q$select public.clinician_system_overview('93000000-0000-4000-8000-000000000001')$q$,'clinical role grants no overview access');
select pg_temp.overview_claims(1,'aal1');
select pg_temp.overview_denied($q$select public.clinician_system_overview('93000000-0000-4000-8000-000000000001')$q$,'MFA policy enforced');
reset role;
update clinical_private.portal_settings set mfa_required=false;
select pg_temp.overview_claims(1,'aal1',true);
set local role authenticated;
select pg_temp.overview_assert(public.clinician_system_overview('93000000-0000-4000-8000-000000000001') is not null,'existing password beta policy respected');
reset role;
update clinical_private.staff set active=false where user_id='91000000-0000-4000-8000-000000000002';
update clinical_private.system_integrations set connected=true where id='hemlakare';
insert into clinical_private.system_integrations(id,name,kind,description,connected) values('new-service','New service','service','Synthetic integration',true);
set local role authenticated;
select pg_temp.overview_assert((public.clinician_system_overview('93000000-0000-4000-8000-000000000001')->'counts'->>'clinician')::int=56,'staff change reflected');
select pg_temp.overview_assert(exists(select 1 from jsonb_array_elements(public.clinician_system_overview('93000000-0000-4000-8000-000000000001')->'integrations')i where i->>'id'='hemlakare' and i->>'connected'='true'),'new connection reflected');
select pg_temp.overview_assert(exists(select 1 from jsonb_array_elements(public.clinician_system_overview('93000000-0000-4000-8000-000000000001')->'integrations')i where i->>'id'='new-service'),'new integration reflected');
reset role;
update clinical_private.system_integrations set enabled=false where id='new-service';
set local role authenticated;
select pg_temp.overview_assert(not exists(select 1 from jsonb_array_elements(public.clinician_system_overview('93000000-0000-4000-8000-000000000001')->'integrations')i where i->>'id'='new-service'),'removed integration reflected');
reset role;
update clinical_private.administrators set active=false where user_id='91000000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.overview_denied($q$select public.clinician_system_overview('93000000-0000-4000-8000-000000000001')$q$,'revocation immediate');
reset role;
select pg_temp.overview_assert((select count(*) from clinical_private.administration_audit where organization_id='93000000-0000-4000-8000-000000000001')=0,'polling does not write repeated open events');
set local role anon;
select pg_temp.overview_denied($q$select public.clinician_system_overview('93000000-0000-4000-8000-000000000001')$q$,'anonymous denied');
reset role;
select 'Overview tests passed: live registry, exact counts, pagination, clinic isolation, no clinical data, assurance, revocation and private registry.' as result;
