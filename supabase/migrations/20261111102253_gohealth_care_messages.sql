create table public.care_provider_patients (
    provider_id uuid not null references auth.users(id) on delete cascade,
    patient_id uuid not null references auth.users(id) on delete cascade,
    primary key (provider_id, patient_id),
    check (provider_id <> patient_id)
);

create index care_provider_patients_patient_idx on public.care_provider_patients (patient_id);

create table public.care_messages (
    id uuid primary key default gen_random_uuid(),
    patient_id uuid not null references auth.users(id) on delete cascade,
    provider_id uuid references auth.users(id) on delete set null default auth.uid(),
    provider_name text not null check (char_length(btrim(provider_name)) between 1 and 120),
    booking_url text not null check (
        char_length(booking_url) <= 2048
        and booking_url ~* '^https://[[:alnum:]][[:alnum:].-]*(:[0-9]+)?([/?#][^[:space:]]*)?$'
    ),
    created_at timestamptz not null default now(),
    resolved_at timestamptz,
    check (provider_id <> patient_id)
);

create index care_messages_patient_order_idx on public.care_messages (patient_id, created_at desc, id desc);
create index care_messages_provider_patient_idx on public.care_messages (provider_id, patient_id, created_at desc);

alter table public.care_provider_patients enable row level security;
alter table public.care_messages enable row level security;

revoke all on public.care_provider_patients, public.care_messages from public, anon, authenticated;
grant select on public.care_provider_patients, public.care_messages to authenticated;
grant insert (id, patient_id, provider_name, booking_url) on public.care_messages to authenticated;
grant update (provider_name, booking_url, resolved_at) on public.care_messages to authenticated;

create policy care_provider_assigned_patients on public.care_provider_patients
    for select to authenticated
    using (provider_id = (select auth.uid()) and (select auth.jwt()->>'aal') = 'aal2');

create policy care_patient_read_own_messages on public.care_messages
    for select to authenticated
    using (patient_id = (select auth.uid()));

create policy care_provider_read_assigned_messages on public.care_messages
    for select to authenticated
    using (provider_id = (select auth.uid()) and (select auth.jwt()->>'aal') = 'aal2'
        and exists (select 1 from public.care_provider_patients as assignment
            where assignment.provider_id = care_messages.provider_id and assignment.patient_id = care_messages.patient_id));

create policy care_provider_send_messages on public.care_messages
    for insert to authenticated
    with check (provider_id = (select auth.uid()) and (select auth.jwt()->>'aal') = 'aal2'
        and exists (select 1 from public.care_provider_patients as assignment
            where assignment.provider_id = care_messages.provider_id and assignment.patient_id = care_messages.patient_id));

create policy care_provider_update_active_messages on public.care_messages
    for update to authenticated
    using (resolved_at is null and provider_id = (select auth.uid()) and (select auth.jwt()->>'aal') = 'aal2'
        and exists (select 1 from public.care_provider_patients as assignment
            where assignment.provider_id = care_messages.provider_id and assignment.patient_id = care_messages.patient_id))
    with check (provider_id = (select auth.uid()) and (select auth.jwt()->>'aal') = 'aal2'
        and exists (select 1 from public.care_provider_patients as assignment
            where assignment.provider_id = care_messages.provider_id and assignment.patient_id = care_messages.patient_id));

create schema if not exists care_private;
revoke all on schema care_private from public, anon, authenticated;

create function care_private.stamp_resolution() returns trigger
    language plpgsql set search_path = pg_catalog
as $$
begin
    if old.resolved_at is null and new.resolved_at is not null then
        new.resolved_at := now();
    end if;
    return new;
end;
$$;

revoke all on function care_private.stamp_resolution() from public, anon, authenticated;

create trigger care_message_stamp_resolution
    before update of resolved_at on public.care_messages
    for each row execute function care_private.stamp_resolution();
