-- Activity deviation uses Apple Health's own daily step total ('steps', deduplicated across iPhone and watch)
-- and falls back to summed raw samples only when no daily total is shared. Raw samples can count a walk twice.
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
  select distinct on (r.patient_id, o->>'code') r.patient_id, o, (r.payload->>'sampledAt')::timestamptz as sampled
  from clinical_private.records r join pool on pool.id = r.patient_id
  cross join lateral jsonb_array_elements(r.payload->'observations') o
  where r.kind = 'lab' and r.status = 'published' and r.superseded_at is null and r.annulled_at is null
    and r.published_at > now() - interval '90 days'
  order by r.patient_id, o->>'code', (r.payload->>'sampledAt')::timestamptz desc
), found as (
  select patient_id, 'resting-heart-rate' as rule, 'warn' as severity, 'Stigande vilopuls' as title,
    round(rmean)::text || ' slag/min senaste 7 dagarna mot ' || round(bmean)::text || ' slag/min tidigare' as detail, last_day as at
  from stats where kind = 'resting-heart-rate' and rn >= 3 and bn >= 14 and rmean - bmean >= 5 and rmean >= bmean * 1.1
  union all
  select patient_id, 'hrv', 'warn', 'Sjunkande HRV',
    round(rmean)::text || ' ms senaste 7 dagarna mot ' || round(bmean)::text || ' ms tidigare', last_day
  from stats where kind = 'hrv' and rn >= 3 and bn >= 14 and rmean <= bmean * 0.8
  union all
  select patient_id, 'sleep', 'info', 'Kortare sömn',
    replace(round((rsleep / 3600)::numeric, 1)::text, '.', ',') || ' tim per natt senaste veckan mot '
      || replace(round((bsleep / 3600)::numeric, 1)::text, '.', ',') || ' tim tidigare', last_day
  from stats where kind = 'sleep' and rnights >= 3 and bnights >= 14 and rsleep <= bsleep - 3600 and rsleep < 6.5 * 3600
  union all
  select patient_id, 'oxygen', case when rmin < 90 then 'high' else 'warn' end, 'Låg syremättnad',
    'Lägsta ' || round(rmin)::text || ' % senaste 7 dagarna', last_day
  from stats where kind = 'oxygen' and rmin < 92
  union all
  select s.patient_id, 'steps', 'info', 'Minskad aktivitet',
    round(s.rday)::text || ' steg per dag senaste veckan mot ' || round(s.bday)::text || ' tidigare', s.last_day
  from stats s
  where s.kind = case when exists (select 1 from stats x where x.patient_id = s.patient_id and x.kind = 'steps') then 'steps' else 'raw.steps' end
    and s.rn >= 4 and s.bn >= 14 and s.rday <= s.bday * 0.6
  union all
  select id, 'sync', 'info', 'Ingen datasynk',
    'Senaste synk för ' || ((now() at time zone 'Europe/Stockholm')::date - (last_sync_at at time zone 'Europe/Stockholm')::date)::text || ' dagar sedan',
    (last_sync_at at time zone 'Europe/Stockholm')::date
  from pool where last_sync_at is not null and last_sync_at < now() - interval '14 days'
  union all
  select patient_id, 'lab', 'warn', 'Provsvar utanför referens',
    (o->>'name') || ' ' || (o->>'value') || coalesce(' ' || nullif(o->>'unit', ''), ''), (sampled at time zone 'Europe/Stockholm')::date
  from labs
  where o->>'comparator' = '=' and o->>'value' ~ '^-?[0-9]+([.,][0-9]+)?$'
    and ((jsonb_typeof(o->'referenceLow') = 'number' and replace(o->>'value', ',', '.')::numeric < (o->>'referenceLow')::numeric)
      or (jsonb_typeof(o->'referenceHigh') = 'number' and replace(o->>'value', ',', '.')::numeric > (o->>'referenceHigh')::numeric))
)
select coalesce(jsonb_agg(jsonb_build_object('patient_id', f.patient_id, 'display_name', pool.display_name, 'rule', f.rule,
    'severity', f.severity, 'title', f.title, 'detail', f.detail, 'at', f.at)
  order by case f.severity when 'high' then 0 when 'warn' then 1 else 2 end, f.at desc nulls last, pool.display_name), '[]'::jsonb)
from found f join pool on pool.id = f.patient_id
$$;
