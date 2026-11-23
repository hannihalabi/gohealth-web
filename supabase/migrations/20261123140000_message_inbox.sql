-- Inbox: every patient conversation the clinician may open, newest first, waiting ones on top.
-- 'mine' marks the clinician's own patients and conversations they have written in.
-- 'poll' is a cheap, unaudited change check (counts and times only); 'list' shows previews and is audited.
create function clinical_private.message_inbox(p_action text) returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare actor uuid := clinical_private.live_actor(); n integer; result jsonb;
begin
  if not clinical_private.portal_assurance_sufficient()
    or not exists (select 1 from clinical_private.staff where user_id = actor and active)
  then raise exception 'Staff authentication required' using errcode = '42501'; end if;
  if p_action is null or p_action not in ('list', 'poll') then raise exception 'Invalid action' using errcode = '22023'; end if;
  delete from clinical_private.request_limits where actor_id = actor and bucket < date_trunc('minute', now()) - interval '1 minute';
  insert into clinical_private.request_limits values (actor, date_trunc('minute', now()), 1)
  on conflict (actor_id, bucket) do update set requests = clinical_private.request_limits.requests + 1 returning requests into n;
  if n > 120 then raise exception 'Request limit' using errcode = '42501'; end if;
  with conv as (
    select m.patient_id, m.organization_id,
      count(*) filter (where m.sender = 'patient' and m.handled_at is null) as waiting,
      max(m.created_at) as last_at
    from clinical_private.patient_messages m
    join clinical_private.staff me on me.user_id = actor and me.active and me.organization_id = m.organization_id
    group by m.patient_id, m.organization_id
  ), visible as (
    select c.*, p.display_name, p.identity_label,
      (exists (select 1 from clinical_private.assignments a where a.patient_id = c.patient_id and a.organization_id = c.organization_id
                and a.clinician_id = actor and a.active)
        or exists (select 1 from clinical_private.patient_messages x where x.patient_id = c.patient_id
                and x.organization_id = c.organization_id and x.author_id = actor)) as mine
    from conv c join clinical_private.patients p on p.id = c.patient_id
    where clinical_private.care_organization(actor, c.patient_id) = c.organization_id
  )
  select case when p_action = 'poll' then
      jsonb_build_object('marker', concat_ws('|', count(*), max(last_at), sum(waiting)),
        'waiting', count(*) filter (where mine and waiting > 0))
    else jsonb_build_object('waiting', count(*) filter (where mine and waiting > 0),
      'conversations', coalesce(jsonb_agg(jsonb_build_object('patient_id', v.patient_id, 'display_name', v.display_name,
          'identity_label', v.identity_label, 'mine', v.mine, 'waiting', v.waiting, 'last_at', v.last_at,
          'last_sender', l.sender, 'last_body', l.body)
        order by (v.waiting > 0) desc, v.last_at desc), '[]'::jsonb))
    end into result
  from visible v
  left join lateral (select x.sender, left(x.body, 200) as body from clinical_private.patient_messages x
    where x.patient_id = v.patient_id and x.organization_id = v.organization_id order by x.created_at desc, x.id desc limit 1) l on true;
  if p_action = 'list' then insert into clinical_private.audit (actor_id, action) values (actor, 'messages.inbox'); end if;
  return result;
end $$;
revoke all on function clinical_private.message_inbox(text) from public, anon, authenticated;
grant execute on function clinical_private.message_inbox(text) to authenticated;
create function public.clinician_message_inbox(p_action text default 'list') returns jsonb
language sql security invoker set search_path = pg_catalog as $$select clinical_private.message_inbox(p_action)$$;
revoke all on function public.clinician_message_inbox(text) from public, anon;
grant execute on function public.clinician_message_inbox(text) to authenticated;
