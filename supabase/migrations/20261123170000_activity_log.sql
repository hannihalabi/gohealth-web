-- Activity per account for the administrator: what every staff member and administrator did, when, and to which
-- patient. Sources: the clinical audit, the administration audit and the sign-in sessions Supabase still holds.
-- Purpose: log review (loggkontroll) and tracing when patient safety must be re-established. Only metadata is
-- shown, never journal content. Every review is itself logged.
create index if not exists audit_actor on clinical_private.audit(actor_id, created_at desc);
create index if not exists administration_audit_actor on clinical_private.administration_audit(organization_id, actor_id, created_at desc);

create function clinical_private.activity_log(org uuid, p_mode text, args jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare
  actor uuid := clinical_private.live_actor();
  n integer;
  days integer := coalesce(nullif(args->>'days', '')::int, 30);
  since timestamptz;
  before timestamptz := nullif(args->>'before', '')::timestamptz;
  before_id text := coalesce(nullif(args->>'before_id', ''), '~');
  target uuid := nullif(args->>'account', '')::uuid;
  category text := coalesce(nullif(args->>'category', ''), 'all');
  routine boolean := coalesce((args->>'routine')::boolean, false);
  result jsonb;
begin
  if not clinical_private.portal_assurance_sufficient() or not exists (
    select 1 from clinical_private.administrators where user_id = actor and organization_id = org and active
  ) then raise exception 'Administrator required' using errcode = '42501'; end if;
  if p_mode is null or p_mode not in ('accounts', 'events') or days not between 1 and 366
    or category not in ('all', 'journal', 'admin', 'login') then raise exception 'Invalid activity request' using errcode = '22023'; end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  since := now() - days * interval '1 day';

  create temp table if not exists pg_temp.activity_people (user_id uuid primary key, display_name text, roles text[], active boolean) on commit drop;
  truncate pg_temp.activity_people;
  insert into pg_temp.activity_people
  select p.user_id, max(p.display_name), array_agg(distinct p.role), bool_or(p.active) from (
    select s.user_id, s.display_name, s.role, s.active from clinical_private.staff s where s.organization_id = org
    union all
    select a.user_id, a.display_name, 'admin', a.active from clinical_private.administrators a where a.organization_id = org
  ) p group by p.user_id;
  if target is not null and not exists (select 1 from pg_temp.activity_people where user_id = target) then
    raise exception 'Account unavailable' using errcode = '42501';
  end if;

  if p_mode = 'accounts' then
    select coalesce(jsonb_agg(jsonb_build_object('user_id', x.user_id, 'display_name', x.display_name, 'roles', x.roles, 'active', x.active,
        'email', x.email, 'last_sign_in_at', x.last_sign_in_at, 'last_activity_at', x.last_at, 'events', x.events, 'sessions', x.sessions)
        order by x.last_at desc nulls last, x.display_name), '[]'::jsonb) into result
    from (
      select pe.*, u.email, u.last_sign_in_at,
        greatest((select max(created_at) from clinical_private.audit where actor_id = pe.user_id),
                 (select max(created_at) from clinical_private.administration_audit where organization_id = org and actor_id = pe.user_id)) as last_at,
        (select count(*) from clinical_private.audit where actor_id = pe.user_id and created_at >= since)
          + (select count(*) from clinical_private.administration_audit where organization_id = org and actor_id = pe.user_id and created_at >= since) as events,
        (select count(*) from auth.sessions s where s.user_id = pe.user_id and (s.not_after is null or s.not_after > now())) as sessions
      from pg_temp.activity_people pe join auth.users u on u.id = pe.user_id
    ) x;
    return jsonb_build_object('days', days, 'accounts', result);
  end if;

  with events as (
    select 'j' || a.id::text as id, a.created_at as at, a.actor_id, 'journal' as category, a.action,
      a.patient_id, p.display_name as patient, a.record_id,
      case when r.id is null then null else jsonb_build_object('kind', r.kind, 'title', r.payload->>'title', 'status', r.status) end as record,
      null::jsonb as details
    from clinical_private.audit a
    join pg_temp.activity_people pe on pe.user_id = a.actor_id
    left join clinical_private.patients p on p.id = a.patient_id
    left join clinical_private.records r on r.id = a.record_id
    where category in ('all', 'journal') and a.created_at >= since and (before is null or a.created_at <= before)
      and (target is null or a.actor_id = target)
      and (routine or a.patient_id is not null)
    union all
    select 'a' || a.id::text, a.created_at, a.actor_id, 'admin', a.action,
      (select pp.id from clinical_private.patients pp where pp.id = a.subject_id),
      (select pp.display_name from clinical_private.patients pp where pp.id = a.subject_id),
      null::uuid, null::jsonb,
      a.details || jsonb_strip_nulls(jsonb_build_object('subject',
        coalesce((select pe2.display_name from pg_temp.activity_people pe2 where pe2.user_id = a.subject_id),
                 (select si.display_name from clinical_private.staff_invitations si where si.id = a.subject_id))))
    from clinical_private.administration_audit a
    where category in ('all', 'admin') and a.organization_id = org and a.created_at >= since and (before is null or a.created_at <= before)
      and (target is null or a.actor_id = target)
      and (routine or a.action not in ('administration.open', 'administration.activity_review'))
    union all
    select 's' || s.id::text, s.created_at, s.user_id, 'login', 'auth.session', null::uuid, null::text, null::uuid, null::jsonb,
      jsonb_strip_nulls(jsonb_build_object('user_agent', left(s.user_agent, 300), 'ip', host(s.ip),
        'active', s.not_after is null or s.not_after > now()))
    from auth.sessions s join pg_temp.activity_people pe on pe.user_id = s.user_id
    where category in ('all', 'login') and s.created_at >= since and (before is null or s.created_at <= before)
      and (target is null or s.user_id = target)
  ), page as (
    -- Keyset on (time, id): events sharing a timestamp are neither skipped nor repeated across pages.
    select * from events where before is null or (at, id) < (before, before_id) order by at desc, id desc limit 101
  )
  select jsonb_build_object(
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'actor_id', e.actor_id,
        'actor', pe.display_name, 'roles', pe.roles, 'category', e.category, 'action', e.action,
        'patient_id', e.patient_id, 'patient', e.patient, 'record_id', e.record_id, 'record', e.record, 'details', e.details) order by e.at desc, e.id desc)
      from (select * from page order by at desc, id desc limit 100) e left join pg_temp.activity_people pe on pe.user_id = e.actor_id), '[]'::jsonb),
    'next', (select case when count(*) > 100 then (select jsonb_build_object('before', q.at, 'before_id', q.id)
        from (select at, id from page order by at desc, id desc offset 99 limit 1) q) end from page)
  ) into result;
  insert into clinical_private.administration_audit (organization_id, actor_id, action, subject_id, details)
  values (org, actor, 'administration.activity_review', target, jsonb_build_object('category', category, 'days', days));
  return result;
end $$;
revoke all on function clinical_private.activity_log(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function clinical_private.activity_log(uuid, text, jsonb) to authenticated;
create function public.clinician_activity_log(p_organization_id uuid, p_mode text, p_args jsonb default '{}') returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.activity_log(p_organization_id, p_mode, p_args)$$;
revoke all on function public.clinician_activity_log(uuid, text, jsonb) from public, anon;
grant execute on function public.clinician_activity_log(uuid, text, jsonb) to authenticated;
