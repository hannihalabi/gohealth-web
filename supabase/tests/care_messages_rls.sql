-- Synthetic fixtures only. The transaction is rolled back.
begin;

insert into auth.users (id, email, aud, role) values
    ('a1100000-0000-4000-8000-000000000001', 'care-test-provider@example.invalid', 'authenticated', 'authenticated'),
    ('a1100000-0000-4000-8000-000000000002', 'care-test-patient@example.invalid', 'authenticated', 'authenticated'),
    ('a1100000-0000-4000-8000-000000000003', 'care-test-other@example.invalid', 'authenticated', 'authenticated');

insert into public.care_provider_patients (provider_id, patient_id)
values ('a1100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000002');

set local role authenticated;
select set_config('request.jwt.claims',
    '{"sub":"a1100000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
do $$
begin
    if exists (select 1 from public.care_provider_patients) then
        raise exception 'Provider assignments exposed without MFA';
    end if;
    begin
        insert into public.care_messages (patient_id, provider_name, booking_url)
        values ('a1100000-0000-4000-8000-000000000002', 'Test clinic', 'https://booking.example.invalid');
        raise exception 'Sending without MFA succeeded';
    exception when insufficient_privilege then null;
    end;
end;
$$;

select set_config('request.jwt.claims',
    '{"sub":"a1100000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', true);
insert into public.care_messages (id, patient_id, provider_name, booking_url)
values ('a1100000-0000-4000-8000-000000000004', 'a1100000-0000-4000-8000-000000000002', 'Test clinic',
    'https://booking.example.invalid/appointment');
insert into public.care_messages (id, patient_id, provider_name, booking_url)
values ('a1100000-0000-4000-8000-000000000004', 'a1100000-0000-4000-8000-000000000002', 'Retry',
    'https://booking.example.invalid/appointment') on conflict (id) do nothing;
do $$
begin
    if not exists (select 1 from public.care_messages where provider_name = 'Test clinic') then
        raise exception 'The authorized send or idempotent retry failed';
    end if;
    begin
        insert into public.care_messages (patient_id, provider_name, booking_url)
        values ('a1100000-0000-4000-8000-000000000003', 'Test clinic', 'https://booking.example.invalid');
        raise exception 'Sending to an unassigned patient succeeded';
    exception when insufficient_privilege then null;
    end;
end;
$$;

select set_config('request.jwt.claims',
    '{"sub":"a1100000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}', true);
do $$
begin
    if not exists (select 1 from public.care_messages where id = 'a1100000-0000-4000-8000-000000000004') then
        raise exception 'Patient could not read their own message';
    end if;
    update public.care_messages set resolved_at = now() where id = 'a1100000-0000-4000-8000-000000000004';
    if found then raise exception 'Patient could close their own case'; end if;
    begin
        insert into public.care_provider_patients (provider_id, patient_id)
        values ('a1100000-0000-4000-8000-000000000002', 'a1100000-0000-4000-8000-000000000003');
        raise exception 'Patient could assign a provider';
    exception when insufficient_privilege then null;
    end;
end;
$$;

select set_config('request.jwt.claims',
    '{"sub":"a1100000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}', true);
do $$
begin
    if exists (select 1 from public.care_messages) then raise exception 'Other patient saw a message'; end if;
end;
$$;

select set_config('request.jwt.claims',
    '{"sub":"a1100000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', true);
do $$
begin
    update public.care_messages set provider_name = 'Updated clinic'
        where id = 'a1100000-0000-4000-8000-000000000004';
    if not found then raise exception 'Provider could not correct an active case'; end if;
    update public.care_messages set resolved_at = '2000-01-01' where id = 'a1100000-0000-4000-8000-000000000004';
    if not found then raise exception 'Provider could not close an active case'; end if;
    if not exists (select 1 from public.care_messages
        where id = 'a1100000-0000-4000-8000-000000000004' and resolved_at = now()) then
        raise exception 'Resolution timestamp was not set by the database';
    end if;
    update public.care_messages set resolved_at = null where id = 'a1100000-0000-4000-8000-000000000004';
    if found then raise exception 'Resolved case could be reopened'; end if;
end;
$$;

select set_config('request.jwt.claims',
    '{"sub":"a1100000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
do $$
begin
    if not exists (select 1 from public.care_messages
        where id = 'a1100000-0000-4000-8000-000000000004' and resolved_at is not null) then
        raise exception 'Patient history lost the resolved case';
    end if;
end;
$$;

set local role anon;
do $$
begin
    begin
        perform 1 from public.care_messages;
        raise exception 'Anonymous message read succeeded';
    exception when insufficient_privilege then null;
    end;
end;
$$;

rollback;
