-- Start page v2: deviations a doctor has reviewed, lab values with their reference range, and the monthly follow-up
-- schedule for the doctor's own patients. Only metadata leaves the database; every review is audited.

-- A doctor marks a deviation as reviewed. The key identifies the finding: a lab value per record, a vital trend per
-- ISO week (a persisting trend comes back for review the next week), a missing sync per last sync date.
create table clinical_private.deviation_reviews (
  patient_id uuid not null references clinical_private.patients,
  key text not null check (length(key) between 1 and 200),
  reviewed_by uuid not null,
  reviewed_at timestamptz not null default now(),
  primary key (patient_id, key)
);
alter table clinical_private.deviation_reviews enable row level security;
revoke all on clinical_private.deviation_reviews from public, anon, authenticated;

create or replace function clinical_private.patient_deviations(p_actor uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog as $$
with pool as (
  select distinct p.id, p.display_name, p.last_sync_at
  from clinical_private.assignments a
  join clinical_private.staff s on s.user_id = a.clinician_id and s.organization_id = a.organization_id and s.active
  join clinical_private.patients p on p.id = a.patient_id
  where a.clinician_id = p_actor and a.active
), today as (select (now() at time zone 'Europe/Stockholm')::date as d),
win as (
  select h.*, case when h.day > t.d - 7 then 'recent' else 'base' end as w
  from clinical_private.health_daily h join pool on pool.id = h.patient_id cross join today t
  where h.day > t.d - 67 and h.day <= t.d and h.kind in ('resting-heart-rate', 'hrv', 'sleep', 'oxygen', 'raw.steps', 'steps')
), stats as (
  select patient_id, kind,
    count(*) filter (where w = 'recent' and n > 0) as rn, count(*) filter (where w = 'base' and n > 0) as bn,
    sum(total) filter (where w = 'recent') / nullif(sum(n) filter (where w = 'recent'), 0) as rmean,
    sum(total) filter (where w = 'base') / nullif(sum(n) filter (where w = 'base'), 0) as bmean,
    avg(total) filter (where w = 'recent' and n > 0) as rday, avg(total) filter (where w = 'base' and n > 0) as bday,
    min(lo) filter (where w = 'recent') as rmin,
    count(*) filter (where w = 'recent' and seconds is not null) as rnights, count(*) filter (where w = 'base' and seconds is not null) as bnights,
    avg(seconds) filter (where w = 'recent') as rsleep, avg(seconds) filter (where w = 'base') as bsleep,
    max(day) filter (where w = 'recent') as last_day
  from win group by patient_id, kind
), labs as (
  -- The newest published value per analysis; custom analyses are told apart by name.
  select distinct on (r.patient_id, coalesce(nullif(o->>'code', 'custom'), 'custom:' || lower(o->>'name')))
    r.patient_id, r.id as record_id, o, (r.payload->>'sampledAt')::timestamptz as sampled,
    coalesce(nullif(o->>'code', 'custom'), 'custom:' || lower(o->>'name')) as analysis
  from clinical_private.records r join pool on pool.id = r.patient_id
  cross join lateral jsonb_array_elements(r.payload->'observations') o
  where r.kind = 'lab' and r.status = 'published' and r.superseded_at is null and r.annulled_at is null
    and r.published_at > now() - interval '90 days'
  order by r.patient_id, coalesce(nullif(o->>'code', 'custom'), 'custom:' || lower(o->>'name')), (r.payload->>'sampledAt')::timestamptz desc
), lab_values as (
  select l.*, replace(o->>'value', ',', '.')::numeric as v,
    case when jsonb_typeof(o->'referenceLow') = 'number' then (o->>'referenceLow')::numeric end as low,
    case when jsonb_typeof(o->'referenceHigh') = 'number' then (o->>'referenceHigh')::numeric end as high
  from labs l where o->>'comparator' = '=' and o->>'value' ~ '^-?[0-9]+([.,][0-9]+)?$'
), found as (
  select patient_id, 'resting-heart-rate' as rule, 'vitals' as category, 'warn' as severity, 'Stigande vilopuls' as title,
    round(rmean)::text || ' slag/min senaste 7 dagarna mot ' || round(bmean)::text || ' slag/min tidigare' as detail, last_day as at,
    'resting-heart-rate:' || to_char(last_day, 'IYYY-IW') as key, null::uuid as record_id,
    jsonb_build_object('recent', round(rmean::numeric, 1), 'base', round(bmean::numeric, 1), 'unit', 'slag/min', 'direction', 'up') as data
  from stats where kind = 'resting-heart-rate' and rn >= 3 and bn >= 14 and rmean - bmean >= 5 and rmean >= bmean * 1.1
  union all
  select patient_id, 'hrv', 'vitals', 'warn', 'Sjunkande HRV',
    round(rmean)::text || ' ms senaste 7 dagarna mot ' || round(bmean)::text || ' ms tidigare', last_day,
    'hrv:' || to_char(last_day, 'IYYY-IW'), null,
    jsonb_build_object('recent', round(rmean::numeric, 1), 'base', round(bmean::numeric, 1), 'unit', 'ms', 'direction', 'down')
  from stats where kind = 'hrv' and rn >= 3 and bn >= 14 and rmean <= bmean * 0.8
  union all
  select patient_id, 'sleep', 'vitals', 'info', 'Kortare sömn',
    replace(round((rsleep / 3600)::numeric, 1)::text, '.', ',') || ' tim per natt senaste veckan mot '
      || replace(round((bsleep / 3600)::numeric, 1)::text, '.', ',') || ' tim tidigare', last_day,
    'sleep:' || to_char(last_day, 'IYYY-IW'), null,
    jsonb_build_object('recent', round((rsleep / 3600)::numeric, 1), 'base', round((bsleep / 3600)::numeric, 1), 'unit', 'tim', 'direction', 'down')
  from stats where kind = 'sleep' and rnights >= 3 and bnights >= 14 and rsleep <= bsleep - 3600 and rsleep < 6.5 * 3600
  union all
  select patient_id, 'oxygen', 'vitals', case when rmin < 90 then 'high' else 'warn' end, 'Låg syremättnad',
    'Lägsta ' || round(rmin)::text || ' % senaste 7 dagarna', last_day,
    'oxygen:' || to_char(last_day, 'IYYY-IW'), null,
    jsonb_build_object('recent', round(rmin::numeric, 1), 'low', 92, 'unit', '%', 'direction', 'down')
  from stats where kind = 'oxygen' and rmin < 92
  union all
  select s.patient_id, 'steps', 'vitals', 'info', 'Minskad aktivitet',
    round(s.rday)::text || ' steg per dag senaste veckan mot ' || round(s.bday)::text || ' tidigare', s.last_day,
    'steps:' || to_char(s.last_day, 'IYYY-IW'), null,
    jsonb_build_object('recent', round(s.rday), 'base', round(s.bday), 'unit', 'steg/dag', 'direction', 'down')
  from stats s
  where s.kind = case when exists (select 1 from stats x where x.patient_id = s.patient_id and x.kind = 'steps') then 'steps' else 'raw.steps' end
    and s.rn >= 4 and s.bn >= 14 and s.rday <= s.bday * 0.6
  union all
  select id, 'sync', 'sync', 'info', 'Ingen datasynk',
    'Senaste synk för ' || ((now() at time zone 'Europe/Stockholm')::date - (last_sync_at at time zone 'Europe/Stockholm')::date)::text || ' dagar sedan',
    (last_sync_at at time zone 'Europe/Stockholm')::date,
    'sync:' || ((last_sync_at at time zone 'Europe/Stockholm')::date)::text, null, '{}'::jsonb
  from pool where last_sync_at is not null and last_sync_at < now() - interval '14 days'
  union all
  select patient_id, 'lab', 'lab', 'warn', 'Provsvar utanför referens',
    (o->>'name') || ' ' || (o->>'value') || coalesce(' ' || nullif(o->>'unit', ''), ''), (sampled at time zone 'Europe/Stockholm')::date,
    'lab:' || record_id::text || ':' || analysis, record_id,
    jsonb_build_object('name', o->>'name', 'value', v, 'unit', nullif(o->>'unit', ''), 'low', low, 'high', high,
      'direction', case when low is not null and v < low then 'low' else 'high' end)
  from lab_values
  where (low is not null and v < low) or (high is not null and v > high)
)
select coalesce(jsonb_agg(jsonb_build_object('patient_id', f.patient_id, 'display_name', pool.display_name, 'rule', f.rule,
    'category', f.category, 'severity', f.severity, 'title', f.title, 'detail', f.detail, 'at', f.at, 'key', f.key,
    'record_id', f.record_id, 'data', f.data)
  order by case f.severity when 'high' then 0 when 'warn' then 1 else 2 end, f.at desc nulls last, pool.display_name), '[]'::jsonb)
from found f join pool on pool.id = f.patient_id
$$;

-- "Granskad": a doctor with access to the patient marks a deviation as looked at, or takes the mark back.
create function clinical_private.review_deviation(args jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor(); pid uuid; org uuid; k text := args->>'key';
begin
  if not clinical_private.portal_assurance_sufficient()
    or not exists (select 1 from clinical_private.staff where user_id = actor and active)
  then raise exception 'Staff authentication required' using errcode = '42501'; end if;
  perform clinical_private.take_request(actor);
  pid := (args->>'patient')::uuid;
  org := clinical_private.care_organization(actor, pid);
  if org is null then raise exception 'Active care relation required' using errcode = '42501'; end if;
  if not exists (select 1 from clinical_private.staff where user_id = actor and organization_id = org and active and role = 'doctor')
  then raise exception 'Doctor required' using errcode = '42501'; end if;
  if k is null or length(k) not between 1 and 200 then raise exception 'Invalid deviation' using errcode = '22023'; end if;
  if coalesce((args->>'undo')::boolean, false) then
    delete from clinical_private.deviation_reviews where patient_id = pid and key = k;
    insert into clinical_private.audit (actor_id, patient_id, action) values (actor, pid, 'deviation.unreview');
  else
    insert into clinical_private.deviation_reviews (patient_id, key, reviewed_by) values (pid, k, actor)
    on conflict (patient_id, key) do nothing;
    insert into clinical_private.audit (actor_id, patient_id, action) values (actor, pid, 'deviation.review');
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function clinical_private.review_deviation(jsonb) from public, anon, authenticated;
grant execute on function clinical_private.review_deviation(jsonb) to authenticated;
create function public.clinician_review_deviation(p_args jsonb) returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.review_deviation(p_args)$$;
revoke all on function public.clinician_review_deviation(jsonb) from public, anon;
grant execute on function public.clinician_review_deviation(jsonb) to authenticated;

-- Start page: adds reviews, the doctor's own bookings (agenda) and the monthly follow-up per own patient.
create or replace function clinical_private.clinician_overview() returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor(); result jsonb; month_start timestamptz;
begin
  if not clinical_private.portal_assurance_sufficient()
    or not exists (select 1 from clinical_private.staff where user_id = actor and active)
  then raise exception 'Staff authentication required' using errcode = '42501'; end if;
  perform clinical_private.take_request(actor);
  month_start := date_trunc('month', now() at time zone 'Europe/Stockholm') at time zone 'Europe/Stockholm';
  with orgs as (select organization_id from clinical_private.staff where user_id = actor and active),
  inbox as (
    select distinct on (m.patient_id, m.organization_id) m.patient_id, p.display_name, left(m.body, 240) as body, m.created_at,
      count(*) over (partition by m.patient_id, m.organization_id) as waiting
    from clinical_private.patient_messages m
    join orgs on orgs.organization_id = m.organization_id
    join clinical_private.patients p on p.id = m.patient_id
    where m.sender = 'patient' and m.handled_at is null
      and (exists (select 1 from clinical_private.assignments a where a.patient_id = m.patient_id and a.organization_id = m.organization_id
             and a.clinician_id = actor and a.active)
        or exists (select 1 from clinical_private.patient_messages x where x.patient_id = m.patient_id
             and x.organization_id = m.organization_id and x.author_id = actor))
    order by m.patient_id, m.organization_id, m.created_at desc
  ),
  drafts as (
    select r.id, r.patient_id, p.display_name, r.kind, r.payload->>'title' as title, r.created_at
    from clinical_private.records r
    join clinical_private.patients p on p.id = r.patient_id
    join orgs on orgs.organization_id = r.organization_id
    where r.status = 'draft' and r.superseded_at is null
      and (r.created_by = actor or exists (select 1 from clinical_private.assignments a
        where a.patient_id = r.patient_id and a.organization_id = r.organization_id and a.clinician_id = actor and a.active))
  ),
  deviations as (
    select d || jsonb_build_object('reviewed_at', rv.reviewed_at,
        'reviewed_by', (select s.display_name from clinical_private.staff s where s.user_id = rv.reviewed_by order by s.organization_id limit 1)) as d, n
    from jsonb_array_elements(clinical_private.patient_deviations(actor)) with ordinality as x(d, n)
    left join clinical_private.deviation_reviews rv on rv.patient_id = (d->>'patient_id')::uuid and rv.key = d->>'key'
  ),
  pool as (
    select distinct on (a.patient_id) a.patient_id, a.organization_id, p.display_name
    from clinical_private.assignments a join clinical_private.patients p on p.id = a.patient_id
    join orgs on orgs.organization_id = a.organization_id
    where a.clinician_id = actor and a.active
    order by a.patient_id, a.organization_id
  ),
  followups as (
    select pool.patient_id, pool.display_name, last.ends_at as last_at, nxt.starts_at as next_at, nxt.visit_type as next_visit_type,
      (last.ends_at at time zone 'Europe/Stockholm')::date + 30 as due_on
    from pool
    left join lateral (select b.ends_at from clinical_private.booking_requests b where b.patient_id = pool.patient_id
      and b.organization_id = pool.organization_id and b.status = 'booked' and b.ends_at < now() order by b.ends_at desc limit 1) last on true
    left join lateral (select b.starts_at, b.visit_type from clinical_private.booking_requests b where b.patient_id = pool.patient_id
      and b.organization_id = pool.organization_id and b.status = 'booked' and b.ends_at >= now() order by b.starts_at limit 1) nxt on true
  )
  select jsonb_build_object(
    'counts', jsonb_build_object(
      'assigned', (select count(distinct a.patient_id) from clinical_private.assignments a
        join orgs on orgs.organization_id = a.organization_id
        join clinical_private.organization_patients op on op.patient_id = a.patient_id and op.organization_id = a.organization_id and op.active
        where a.clinician_id = actor and a.active),
      'clinic', (select count(distinct op.patient_id) from clinical_private.organization_patients op
        join orgs on orgs.organization_id = op.organization_id where op.active),
      'unsigned', (select count(*) from drafts),
      'review', (select count(*) from deviations where d->>'reviewed_at' is null and d->>'category' <> 'sync'),
      'consultations', (select count(*) from clinical_private.consultations c where c.to_user = actor and c.status = 'open'),
      'messages', (select count(*) from inbox)),
    'role', (select s.role from clinical_private.staff s where s.user_id = actor and s.active order by s.organization_id limit 1),
    'unsigned', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at desc) from (select * from drafts order by created_at desc limit 8) d), '[]'::jsonb),
    'announcements', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'created_at', a.created_at,
        'author', coalesce(ad.display_name, 'Administratör')) order by a.created_at desc)
      from (select sa.* from clinical_private.staff_announcements sa join orgs on orgs.organization_id = sa.organization_id
            where sa.archived_at is null and (sa.expires_at is null or sa.expires_at > now()) order by sa.created_at desc limit 10) a
      left join clinical_private.administrators ad on ad.user_id = a.created_by and ad.organization_id = a.organization_id), '[]'::jsonb),
    'consultations', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'patient_id', c.patient_id, 'display_name', p.display_name,
        'direction', case when c.to_user = actor then 'in' else 'out' end, 'status', c.status, 'message', c.message, 'reply', c.reply,
        'created_at', c.created_at, 'replied_at', c.replied_at,
        'from_name', (select s.display_name from clinical_private.staff s where s.user_id = c.from_user and s.organization_id = c.organization_id),
        'to_name', (select s.display_name from clinical_private.staff s where s.user_id = c.to_user and s.organization_id = c.organization_id),
        'record', (select jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.payload->>'title') from clinical_private.records r where r.id = c.record_id))
        order by (c.status = 'open' and c.to_user = actor) desc, coalesce(c.replied_at, c.created_at) desc)
      from (select * from clinical_private.consultations where (to_user = actor or from_user = actor) and status <> 'closed'
            order by created_at desc limit 30) c
      join clinical_private.patients p on p.id = c.patient_id), '[]'::jsonb),
    'deviations', coalesce((select jsonb_agg(d order by n) from deviations), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at desc) from (select * from inbox order by created_at desc limit 20) i), '[]'::jsonb),
    -- My own booked meetings from the start of this month, eight weeks ahead.
    'agenda', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'patient_id', b.patient_id, 'display_name', p.display_name,
        'visit_type', b.visit_type, 'starts_at', b.starts_at, 'ends_at', b.ends_at) order by b.starts_at)
      from (select * from clinical_private.booking_requests where clinician_id = actor and status = 'booked'
            and starts_at >= month_start and starts_at < now() + interval '56 days' order by starts_at limit 200) b
      join clinical_private.patients p on p.id = b.patient_id), '[]'::jsonb),
    -- Monthly follow-up: last and next meeting per own patient, due 30 days after the last one.
    'followups', coalesce((select jsonb_agg(jsonb_build_object('patient_id', f.patient_id, 'display_name', f.display_name,
        'last_at', f.last_at, 'next_at', f.next_at, 'next_visit_type', f.next_visit_type, 'due_on', f.due_on)
        order by f.next_at is not null, f.due_on nulls first, f.display_name)
      from followups f), '[]'::jsonb)
  ) into result;
  insert into clinical_private.audit (actor_id, action) values (actor, 'clinician.overview');
  return result;
end $$;
