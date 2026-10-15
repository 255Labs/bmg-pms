-- module: integrations
-- also: back-office, core
-- =====================================================================
-- BMG PMS — 08 INTEGRATIONS (middleware data layer)
-- A job queue (outbox) filled by triggers, integration logs, Channex
-- booking revisions, TTLock door events and guest passcodes, Hikvision
-- camera events, TRA fiscal receipts, and the revenue assurance report.
-- Workers (Supabase Edge Functions) call the pms_svc_* functions with the
-- service role key; staff never can.
-- =====================================================================

alter table pms_properties add column if not exists timezone text not null default 'Africa/Dar_es_Salaam';

alter table pms_integrations drop constraint if exists pms_integrations_provider_check;
alter table pms_integrations add constraint pms_integrations_provider_check check (provider in ('channex','ttlock','hikvision','fiscal'));
alter table pms_external_ids drop constraint if exists pms_external_ids_provider_check;
alter table pms_external_ids add constraint pms_external_ids_provider_check check (provider in ('channex','ttlock','hikvision','fiscal'));

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table if not exists pms_jobs (
  id            bigserial primary key,
  property_id   uuid not null references pms_properties(id) on delete cascade,
  provider      text not null check (provider in ('channex','ttlock','hikvision','fiscal')),
  kind          text not null,
  payload       jsonb not null default '{}'::jsonb,
  dedupe_key    text,
  status        text not null default 'queued' check (status in ('queued','running','done','failed')),
  attempts      integer not null default 0,
  max_attempts  integer not null default 8,
  run_after     timestamptz not null default now(),
  last_error    text,
  result        jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists uq_pms_jobs_dedupe on pms_jobs(dedupe_key) where status = 'queued';
create index if not exists idx_pms_jobs_ready on pms_jobs(provider, status, run_after);

create table if not exists pms_integration_log (
  id           bigserial primary key,
  property_id  uuid references pms_properties(id) on delete cascade,
  provider     text not null,
  direction    text not null check (direction in ('out','in')),
  action       text not null,
  ok           boolean not null,
  status_code  integer,
  request      jsonb,
  response     jsonb,
  error        text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_pms_integration_log on pms_integration_log(property_id, provider, created_at desc);

-- Each Channex rate plan belongs to one room type, so map the pair
create table if not exists pms_channex_rate_map (
  property_id           uuid not null references pms_properties(id) on delete cascade,
  room_type_id          uuid not null references pms_room_types(id) on delete cascade,
  rate_plan_id          uuid not null references pms_rate_plans(id) on delete cascade,
  channex_rate_plan_id  text not null,
  primary key (room_type_id, rate_plan_id)
);

create table if not exists pms_channex_revisions (
  revision_id     text primary key,
  property_id     uuid not null references pms_properties(id) on delete cascade,
  booking_id      text,
  status          text,
  ota_name        text,
  ota_code        text,
  reservation_id  uuid references pms_reservations(id) on delete set null,
  ok              boolean,
  note            text,
  raw             jsonb,
  received_at     timestamptz not null default now()
);

create table if not exists pms_door_events (
  id                  bigserial primary key,
  property_id         uuid not null references pms_properties(id) on delete cascade,
  provider_record_id  text not null,
  lock_id             text not null,
  room_id             uuid references pms_rooms(id) on delete set null,
  event_time          timestamptz not null,
  record_type         integer,
  method              text,
  success             boolean not null default true,
  username            text,
  raw                 jsonb,
  unique (property_id, provider_record_id)
);
create index if not exists idx_pms_door_events on pms_door_events(property_id, room_id, event_time);
-- Only events that open the door count as entries; lock, alarm and sensor-closed events do not
alter table pms_door_events add column if not exists is_open boolean
  generated always as (record_type is null or record_type in (1,4,7,8,9,10,12,31,32,37,46,49,55,57,63)) stored;

create table if not exists pms_camera_events (
  id           bigserial primary key,
  property_id  uuid not null references pms_properties(id) on delete cascade,
  device       text not null default '',
  channel      text not null,
  room_id      uuid references pms_rooms(id) on delete set null,
  event_type   text not null,
  event_time   timestamptz not null,
  raw          jsonb,
  unique (property_id, device, channel, event_type, event_time)
);
create index if not exists idx_pms_camera_events on pms_camera_events(property_id, room_id, event_time);

create table if not exists pms_stay_passcodes (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references pms_properties(id) on delete cascade,
  stay_id          uuid not null references pms_stays(id) on delete cascade,
  room_id          uuid not null references pms_rooms(id),
  lock_id          text not null,
  passcode         text not null,
  provider_pwd_id  text,
  valid_from       timestamptz not null,
  valid_to         timestamptz not null,
  status           text not null default 'pending' check (status in ('pending','issued','revoked','failed')),
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_pms_stay_passcodes on pms_stay_passcodes(stay_id);

create table if not exists pms_fiscal_receipts (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references pms_properties(id) on delete cascade,
  folio_line_id      uuid unique references pms_folio_lines(id) on delete cascade,
  pos_bill_id        uuid unique references pms_pos_bills(id) on delete cascade,
  amount             numeric(14,2) not null,
  customer_name      text,
  status             text not null default 'pending' check (status in ('pending','issued','failed','manual')),
  receipt_no         text,
  verification_code  text,
  verify_url         text,
  issued_at          timestamptz,
  error              text,
  raw                jsonb,
  created_at         timestamptz not null default now(),
  check (folio_line_id is not null or pos_bill_id is not null)
);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function pms__is_service() returns boolean
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::json->>'role', '') = 'service_role'
      or session_user in ('postgres', 'supabase_admin')
$$;

create or replace function pms__require_service() returns void
language plpgsql stable as $$
begin
  if not pms__is_service() then raise exception 'Only the integration service can call this'; end if;
end $$;

create or replace function pms__integration_on(p_property uuid, p_provider text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select enabled from pms_integrations where property_id = p_property and provider = p_provider), false)
$$;

create or replace function pms__enqueue(p_property uuid, p_provider text, p_kind text, p_payload jsonb, p_dedupe text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_dedupe is not null then
    update pms_jobs set payload = p_payload, updated_at = now() where dedupe_key = p_dedupe and status = 'queued';
    if found then return; end if;
  end if;
  insert into pms_jobs(property_id, provider, kind, payload, dedupe_key) values (p_property, p_provider, p_kind, p_payload, p_dedupe);
end $$;

-- Coalesce availability/rate pushes into one queued job per property with a widening date range
create or replace function pms__enqueue_ari(p_property uuid, p_from date, p_to date) returns void
language plpgsql security definer set search_path = public as $$
declare v_key text := 'channex:ari:' || p_property; j pms_jobs; v_bd date;
begin
  if not pms__integration_on(p_property, 'channex') then return; end if;
  select business_date into v_bd from pms_properties where id = p_property;
  p_from := greatest(p_from, v_bd);
  if p_to < p_from then return; end if;
  select * into j from pms_jobs where dedupe_key = v_key and status = 'queued' for update;
  if found then
    update pms_jobs set payload = jsonb_build_object(
        'date_from', least((j.payload->>'date_from')::date, p_from),
        'date_to', greatest((j.payload->>'date_to')::date, p_to)), updated_at = now()
    where id = j.id;
  else
    insert into pms_jobs(property_id, provider, kind, payload, dedupe_key)
    values (p_property, 'channex', 'ari_push', jsonb_build_object('date_from', p_from, 'date_to', p_to), v_key);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Triggers that feed the queue
-- ---------------------------------------------------------------------
create or replace function pms_trg_ari_stays() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE','DELETE') then perform pms__enqueue_ari(old.property_id, old.arrival, old.departure); end if;
  if tg_op in ('INSERT','UPDATE') then perform pms__enqueue_ari(new.property_id, new.arrival, new.departure); end if;
  return null;
end $$;
drop trigger if exists trg_ari_stays on pms_stays;
create trigger trg_ari_stays after insert or update of arrival, departure, status, room_type_id or delete on pms_stays
  for each row execute function pms_trg_ari_stays();

create or replace function pms_trg_ari_blocks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform pms__enqueue_ari(new.property_id, new.from_date, new.to_date);
  return null;
end $$;
drop trigger if exists trg_ari_blocks on pms_maintenance_blocks;
create trigger trg_ari_blocks after insert or update on pms_maintenance_blocks for each row execute function pms_trg_ari_blocks();

create or replace function pms_trg_ari_rates() returns trigger
language plpgsql security definer set search_path = public as $$
declare r pms_rates := coalesce(new, old);
begin
  perform pms__enqueue_ari(r.property_id, r.rate_date, r.rate_date + 1);
  return null;
end $$;
drop trigger if exists trg_ari_rates on pms_rates;
create trigger trg_ari_rates after insert or update or delete on pms_rates for each row execute function pms_trg_ari_rates();

-- Guest door passcodes follow the stay
create or replace function pms_trg_ttlock_stays() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not pms__integration_on(new.property_id, 'ttlock') then return null; end if;
  if new.status = 'checked_in' and (old.status <> 'checked_in' or new.room_id is distinct from old.room_id) then
    if old.status = 'checked_in' and new.room_id is distinct from old.room_id then
      perform pms__enqueue(new.property_id, 'ttlock', 'revoke_passcode', jsonb_build_object('stay_id', new.id, 'room_id', old.room_id));
    end if;
    perform pms__enqueue(new.property_id, 'ttlock', 'issue_passcode', jsonb_build_object('stay_id', new.id));
  elsif old.status = 'checked_in' and new.status = 'checked_out' then
    perform pms__enqueue(new.property_id, 'ttlock', 'revoke_passcode', jsonb_build_object('stay_id', new.id));
  elsif new.status = 'checked_in' and new.departure <> old.departure then
    perform pms__enqueue(new.property_id, 'ttlock', 'extend_passcode', jsonb_build_object('stay_id', new.id), 'ttlock:extend:' || new.id);
  end if;
  return null;
end $$;
drop trigger if exists trg_ttlock_stays on pms_stays;
create trigger trg_ttlock_stays after update of status, room_id, departure on pms_stays for each row execute function pms_trg_ttlock_stays();

-- A fiscal receipt for every payment taken and every walk-in POS bill
create or replace function pms_trg_fiscal_payment() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_name text;
begin
  if new.line_type <> 'payment' or coalesce(new.payment_method, '') = 'city_ledger' or new.source = 'system' then return null; end if;
  if not pms__integration_on(new.property_id, 'fiscal') then return null; end if;
  select pms__guest_name(g) into v_name from pms_folios f join pms_guests g on g.id = f.guest_id where f.id = new.folio_id;
  insert into pms_fiscal_receipts(property_id, folio_line_id, amount, customer_name) values (new.property_id, new.id, -new.amount, v_name)
  returning id into v_id;
  perform pms__enqueue(new.property_id, 'fiscal', 'issue_receipt', jsonb_build_object('receipt_id', v_id));
  return null;
end $$;
drop trigger if exists trg_fiscal_payment on pms_folio_lines;
create trigger trg_fiscal_payment after insert on pms_folio_lines for each row execute function pms_trg_fiscal_payment();

create or replace function pms_trg_fiscal_pos() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if new.status = 'settled' and old.status = 'open' and pms__integration_on(new.property_id, 'fiscal') then
    insert into pms_fiscal_receipts(property_id, pos_bill_id, amount, customer_name) values (new.property_id, new.id, new.total, 'Walk-in')
    returning id into v_id;
    perform pms__enqueue(new.property_id, 'fiscal', 'issue_receipt', jsonb_build_object('receipt_id', v_id));
  end if;
  return null;
end $$;
drop trigger if exists trg_fiscal_pos on pms_pos_bills;
create trigger trg_fiscal_pos after update of status on pms_pos_bills for each row execute function pms_trg_fiscal_pos();

-- ---------------------------------------------------------------------
-- Worker functions (service role only)
-- ---------------------------------------------------------------------
create or replace function pms_svc_enabled(p_provider text)
returns table(property_id uuid, property_name text, timezone text, currency text, config jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_service();
  return query select p.id, p.name, p.timezone, p.currency, i.config
    from pms_integrations i join pms_properties p on p.id = i.property_id
    where i.provider = p_provider and i.enabled;
end $$;

create or replace function pms_svc_claim_jobs(p_provider text, p_limit int default 20)
returns setof pms_jobs
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_service();
  return query
    update pms_jobs j set status = 'running', attempts = j.attempts + 1, updated_at = now()
    where j.id in (select id from pms_jobs where provider = p_provider and status = 'queued' and run_after <= now()
                   order by id limit p_limit for update skip locked)
    returning j.*;
end $$;

create or replace function pms_svc_finish_job(p_job bigint, p_ok boolean, p_error text default null, p_result jsonb default null) returns void
language plpgsql security definer set search_path = public as $$
declare j pms_jobs;
begin
  perform pms__require_service();
  select * into j from pms_jobs where id = p_job for update;
  if not found then return; end if;
  if p_ok then
    update pms_jobs set status = 'done', result = p_result, last_error = null, updated_at = now() where id = p_job;
  elsif j.attempts >= j.max_attempts then
    update pms_jobs set status = 'failed', last_error = p_error, result = p_result, updated_at = now() where id = p_job;
  else
    -- back off 1, 2, 4, 8 … minutes; a newer queued job with the same key takes over
    update pms_jobs set status = case when j.dedupe_key is not null and exists (select 1 from pms_jobs where dedupe_key = j.dedupe_key and status = 'queued' and id <> j.id) then 'done' else 'queued' end,
      last_error = p_error, run_after = now() + make_interval(mins => power(2, least(j.attempts - 1, 7))::int), updated_at = now()
    where id = p_job;
  end if;
end $$;

create or replace function pms_svc_log(p_property uuid, p_provider text, p_direction text, p_action text, p_ok boolean,
  p_status int default null, p_request jsonb default null, p_response jsonb default null, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_service();
  insert into pms_integration_log(property_id, provider, direction, action, ok, status_code, request, response, error)
  values (p_property, p_provider, p_direction, p_action, p_ok, p_status, p_request, p_response, left(p_error, 2000));
end $$;

create or replace function pms_svc_merge_config(p_property uuid, p_provider text, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_service();
  update pms_integrations set config = config || p_patch, updated_at = now() where property_id = p_property and provider = p_provider;
end $$;

-- Availability and rates for Channex, one value per mapped room type / rate plan per night
create or replace function pms_svc_ari_snapshot(p_property uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_avail jsonb; v_rates jsonb;
begin
  perform pms__require_service();
  select coalesce(jsonb_agg(jsonb_build_object('room_type_id', x.external_id, 'date', d::date,
      'availability', greatest(0, pms_type_availability(x.entity_id, d::date))) order by x.external_id, d), '[]'::jsonb)
    into v_avail
  from pms_external_ids x cross join generate_series(p_from, p_to - 1, interval '1 day') d
  where x.property_id = p_property and x.provider = 'channex' and x.entity = 'room_type';

  select coalesce(jsonb_agg(jsonb_build_object('rate_plan_id', m.channex_rate_plan_id, 'date', d::date,
      'rate', pms_rate(m.room_type_id, m.rate_plan_id, d::date)) order by m.channex_rate_plan_id, d), '[]'::jsonb)
    into v_rates
  from pms_channex_rate_map m cross join generate_series(p_from, p_to - 1, interval '1 day') d
  where m.property_id = p_property;

  return jsonb_build_object('availability', v_avail, 'rates', v_rates);
end $$;

-- Turn a Channex booking revision into a reservation (new / modified / cancelled)
create or replace function pms_svc_channex_ingest(p_property uuid, p_rev jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p pms_properties; v_rev_id text := p_rev->>'id'; v_status text := p_rev->>'status';
  v_booking text := p_rev->>'booking_id'; v_res uuid; v_guest uuid; v_res_no int; v_src uuid; v_plan uuid;
  v_room jsonb; v_type uuid; v_rate numeric; v_nights int; v_fx numeric := 1; v_cur text; v_note text := '';
  v_stay uuid; v_checked_in boolean; c jsonb;
begin
  perform pms__require_service();
  select * into p from pms_properties where id = p_property for update;
  if exists (select 1 from pms_channex_revisions where revision_id = v_rev_id and ok) then
    return jsonb_build_object('action', 'duplicate', 'revision_id', v_rev_id);
  end if;

  select id into v_res from pms_reservations where property_id = p_property and external_ref = v_booking;

  -- currency: OTA amounts converted to the property currency at the latest rate
  v_cur := upper(coalesce(p_rev->>'currency', p.currency));
  if v_cur <> p.currency then
    v_fx := pms_fx_rate(p_property, v_cur, p.business_date);
    if v_fx is null then v_fx := 1; v_note := v_note || 'No ' || v_cur || ' rate set; amounts kept unconverted. '; end if;
  end if;

  if v_status = 'cancelled' then
    if v_res is null then
      v_note := v_note || 'Cancellation for a booking not in the PMS.';
    else
      update pms_stays set status = 'cancelled' where reservation_id = v_res and status in ('tentative','confirmed');
      if exists (select 1 from pms_stays where reservation_id = v_res and status = 'checked_in') then
        v_note := v_note || 'Guest already checked in; in-house rooms were not cancelled. ';
      end if;
      perform pms__refresh_reservation(v_res);
      insert into pms_audit_log(property_id, action, entity, entity_id, details)
      values (p_property, 'channex.cancel', 'reservation', v_res, jsonb_build_object('revision', v_rev_id));
    end if;
  else
    c := p_rev->'customer';
    select id into v_src from pms_business_sources where property_id = p_property and lower(name) = lower(coalesce(p_rev->>'ota_name', ''));
    if v_src is null then
      insert into pms_business_sources(property_id, name, kind) values (p_property, coalesce(nullif(p_rev->>'ota_name', ''), 'Channel manager'), 'ota')
      on conflict (property_id, name) do update set name = excluded.name returning id into v_src;
    end if;

    if v_res is null then
      insert into pms_guests(property_id, first_name, last_name, phone, email, nationality)
      values (p_property, coalesce(nullif(c->>'name', ''), 'OTA guest'), nullif(c->>'surname', ''), nullif(c->>'phone', ''),
              nullif(c->>'mail', ''), nullif(c->>'country', ''))
      returning id into v_guest;
      v_res_no := p.next_res_no;
      update pms_properties set next_res_no = next_res_no + 1 where id = p_property;
      insert into pms_reservations(property_id, res_no, guest_id, source_id, status, arrival, departure, notes, external_ref)
      values (p_property, v_res_no, v_guest, v_src, 'confirmed', (p_rev->>'arrival_date')::date, (p_rev->>'departure_date')::date,
              nullif(concat_ws(E'\n', nullif(p_rev->>'notes', ''), coalesce(p_rev->>'ota_name', 'OTA') || ' ' || coalesce(p_rev->>'ota_reservation_code', '')), ''),
              v_booking)
      returning id into v_res;
    else
      select exists (select 1 from pms_stays where reservation_id = v_res and status = 'checked_in') into v_checked_in;
      if v_checked_in then
        v_note := v_note || 'Modification arrived after check-in; review the stay by hand. ';
        insert into pms_channex_revisions(revision_id, property_id, booking_id, status, ota_name, ota_code, reservation_id, ok, note, raw)
        values (v_rev_id, p_property, v_booking, v_status, p_rev->>'ota_name', p_rev->>'ota_reservation_code', v_res, true, v_note, p_rev)
        on conflict (revision_id) do update set ok = true, note = excluded.note, raw = excluded.raw;
        return jsonb_build_object('action', 'needs_review', 'reservation_id', v_res, 'note', v_note);
      end if;
      -- replace the rooms: the revision always carries the full booking
      update pms_stays set status = 'cancelled' where reservation_id = v_res and status in ('tentative','confirmed');
      update pms_folios set status = 'closed', closed_at = now()
        where reservation_id = v_res and status = 'open' and not exists (select 1 from pms_folio_lines l where l.folio_id = pms_folios.id and not l.voided);
      update pms_reservations set arrival = (p_rev->>'arrival_date')::date, departure = (p_rev->>'departure_date')::date where id = v_res;
      select guest_id into v_guest from pms_reservations where id = v_res;
    end if;

    for v_room in select * from jsonb_array_elements(coalesce(p_rev->'rooms', '[]'::jsonb)) loop
      select entity_id into v_type from pms_external_ids
      where property_id = p_property and provider = 'channex' and entity = 'room_type' and external_id = v_room->>'room_type_id';
      if v_type is null then
        v_note := v_note || 'Unmapped Channex room type ' || coalesce(v_room->>'room_type_id', '?') || '; booked as the first room type. ';
        select id into v_type from pms_room_types where property_id = p_property and active order by sort_order, name limit 1;
      end if;
      select m.rate_plan_id into v_plan from pms_channex_rate_map m where m.property_id = p_property and m.channex_rate_plan_id = v_room->>'rate_plan_id';
      v_nights := greatest(1, ((coalesce(v_room->>'checkout_date', p_rev->>'departure_date'))::date - (coalesce(v_room->>'checkin_date', p_rev->>'arrival_date'))::date));
      v_rate := round(coalesce((v_room->>'amount')::numeric, 0) * v_fx / v_nights, 2);
      insert into pms_stays(property_id, reservation_id, room_type_id, arrival, departure, adults, children, rate, status)
      values (p_property, v_res, v_type, coalesce(v_room->>'checkin_date', p_rev->>'arrival_date')::date,
              coalesce(v_room->>'checkout_date', p_rev->>'departure_date')::date,
              coalesce((v_room->'occupancy'->>'adults')::int, 1), coalesce((v_room->'occupancy'->>'children')::int, 0), v_rate, 'confirmed')
      returning id into v_stay;
      insert into pms_folios(property_id, folio_no, reservation_id, stay_id, guest_id)
      values (p_property, pms__next_folio_no(p_property), v_res, v_stay, v_guest);
      if pms_type_availability(v_type, coalesce(v_room->>'checkin_date', p_rev->>'arrival_date')::date) < 0 then
        v_note := v_note || 'Overbooked: more rooms sold than available for this type. ';
      end if;
    end loop;
    if v_plan is not null then update pms_reservations set rate_plan_id = v_plan where id = v_res; end if;
    perform pms__refresh_reservation(v_res);
    insert into pms_audit_log(property_id, action, entity, entity_id, details)
    values (p_property, case when v_status = 'new' then 'channex.new' else 'channex.modify' end, 'reservation', v_res,
            jsonb_build_object('revision', v_rev_id, 'ota', p_rev->>'ota_name', 'code', p_rev->>'ota_reservation_code'));
  end if;

  insert into pms_channex_revisions(revision_id, property_id, booking_id, status, ota_name, ota_code, reservation_id, ok, note, raw)
  values (v_rev_id, p_property, v_booking, v_status, p_rev->>'ota_name', p_rev->>'ota_reservation_code', v_res, true, nullif(v_note, ''), p_rev)
  on conflict (revision_id) do update set ok = true, reservation_id = excluded.reservation_id, note = excluded.note, raw = excluded.raw;
  return jsonb_build_object('action', coalesce(v_status, 'new'), 'reservation_id', v_res, 'note', nullif(v_note, ''));
end $$;

-- Door records from TTLock; the room comes from the lockId mapping
create or replace function pms_svc_ingest_door_events(p_property uuid, p_events jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform pms__require_service();
  with ins as (
    insert into pms_door_events(property_id, provider_record_id, lock_id, room_id, event_time, record_type, method, success, username, raw)
    select p_property, e->>'record_id', e->>'lock_id',
      (select x.entity_id from pms_external_ids x where x.property_id = p_property and x.provider = 'ttlock' and x.entity = 'room' and x.external_id = e->>'lock_id'),
      to_timestamp((e->>'time_ms')::bigint / 1000.0), (e->>'record_type')::int, e->>'method',
      coalesce((e->>'success')::boolean, true), e->>'username', e
    from jsonb_array_elements(p_events) e
    on conflict (property_id, provider_record_id) do nothing
    returning 1)
  select count(*) into v_n from ins;
  return v_n;
end $$;

-- Camera events from the on-site relay; the room comes from the channel mapping
create or replace function pms_svc_ingest_camera_events(p_property uuid, p_events jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform pms__require_service();
  with ins as (
    insert into pms_camera_events(property_id, device, channel, room_id, event_type, event_time, raw)
    select p_property, coalesce(e->>'device', ''), e->>'channel',
      (select x.entity_id from pms_external_ids x where x.property_id = p_property and x.provider = 'hikvision' and x.entity = 'room'
         and x.external_id in (e->>'channel', coalesce(e->>'device', '') || ':' || (e->>'channel'))),
      coalesce(e->>'event_type', 'motion'), (e->>'time')::timestamptz, e
    from jsonb_array_elements(p_events) e
    where e ? 'channel' and e ? 'time'
    on conflict (property_id, device, channel, event_type, event_time) do nothing
    returning 1)
  select count(*) into v_n from ins;
  return v_n;
end $$;

-- What a passcode job needs to know about the stay
create or replace function pms_svc_passcode_context(p_stay uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform pms__require_service();
  select jsonb_build_object(
    'stay_id', s.id, 'property_id', s.property_id, 'status', s.status, 'room_id', s.room_id, 'room', r.number,
    'lock_id', (select external_id from pms_external_ids x where x.provider = 'ttlock' and x.entity = 'room' and x.entity_id = s.room_id),
    'guest', pms__guest_name(g), 'valid_from', (s.arrival::text || ' ' || p.check_in_time::text)::timestamp at time zone p.timezone,
    'valid_to', (s.departure::text || ' ' || p.check_out_time::text)::timestamp at time zone p.timezone + interval '1 hour',
    'passcodes', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'lock_id', c.lock_id, 'room_id', c.room_id, 'provider_pwd_id', c.provider_pwd_id, 'status', c.status))
                           from pms_stay_passcodes c where c.stay_id = s.id), '[]'::jsonb))
  into v
  from pms_stays s join pms_rooms r on r.id = s.room_id join pms_properties p on p.id = s.property_id
  join pms_reservations rs on rs.id = s.reservation_id join pms_guests g on g.id = rs.guest_id
  where s.id = p_stay;
  return v;
end $$;

create or replace function pms_svc_record_passcode(p_stay uuid, p_lock text, p_passcode text, p_pwd_id text,
  p_from timestamptz, p_to timestamptz, p_status text, p_error text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; s pms_stays;
begin
  perform pms__require_service();
  select * into s from pms_stays where id = p_stay;
  insert into pms_stay_passcodes(property_id, stay_id, room_id, lock_id, passcode, provider_pwd_id, valid_from, valid_to, status, error)
  values (s.property_id, p_stay, s.room_id, p_lock, p_passcode, p_pwd_id, p_from, p_to, p_status, p_error) returning id into v_id;
  return v_id;
end $$;

create or replace function pms_svc_update_passcode(p_id uuid, p_status text, p_valid_to timestamptz default null, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_service();
  update pms_stay_passcodes set status = p_status, valid_to = coalesce(p_valid_to, valid_to), error = p_error, updated_at = now() where id = p_id;
end $$;

create or replace function pms_svc_fiscal_context(p_receipt uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform pms__require_service();
  select jsonb_build_object('receipt_id', f.id, 'property_id', f.property_id, 'amount', f.amount, 'customer', f.customer_name,
    'status', f.status, 'tin', p.tin, 'vrn', p.vrn, 'property', p.name, 'currency', p.currency, 'tax_rate', p.tax_rate,
    'reference', coalesce('R' || lpad(l.receipt_no::text, 5, '0'), 'POS ' || b.bill_no::text),
    'method', coalesce(l.payment_method, b.payment_method),
    'items', case when b.id is not null then
        (select jsonb_agg(jsonb_build_object('name', i.name, 'qty', i.qty, 'price', i.price, 'amount', i.amount)) from pms_pos_bill_items i where i.bill_id = b.id)
      else jsonb_build_array(jsonb_build_object('name', 'Accommodation and services', 'qty', 1, 'price', f.amount, 'amount', f.amount)) end)
  into v
  from pms_fiscal_receipts f join pms_properties p on p.id = f.property_id
  left join pms_folio_lines l on l.id = f.folio_line_id left join pms_pos_bills b on b.id = f.pos_bill_id
  where f.id = p_receipt;
  return v;
end $$;

create or replace function pms_svc_fiscal_result(p_receipt uuid, p_ok boolean, p_receipt_no text default null,
  p_vcode text default null, p_url text default null, p_error text default null, p_raw jsonb default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_service();
  update pms_fiscal_receipts set status = case when p_ok then 'issued' else 'failed' end, receipt_no = p_receipt_no,
    verification_code = p_vcode, verify_url = p_url, error = p_error, raw = p_raw, issued_at = case when p_ok then now() end
  where id = p_receipt and status <> 'manual';
end $$;

-- ---------------------------------------------------------------------
-- Staff-facing functions
-- ---------------------------------------------------------------------
-- Record a fiscal receipt issued on the physical EFD when the service is down
create or replace function pms_fiscal_manual(p_receipt uuid, p_receipt_no text, p_vcode text default null) returns void
language plpgsql security definer set search_path = public as $$
declare f pms_fiscal_receipts;
begin
  select * into f from pms_fiscal_receipts where id = p_receipt;
  if not found then raise exception 'Receipt not found'; end if;
  perform pms_require(f.property_id, array['owner','manager','accountant']);
  if f.status = 'issued' then raise exception 'Already issued by the service'; end if;
  if coalesce(trim(p_receipt_no), '') = '' then raise exception 'Enter the EFD receipt number'; end if;
  update pms_fiscal_receipts set status = 'manual', receipt_no = trim(p_receipt_no), verification_code = p_vcode, issued_at = now(), error = null where id = p_receipt;
  update pms_jobs set status = 'done', last_error = 'Recorded manually', updated_at = now()
    where provider = 'fiscal' and status in ('queued','failed') and payload->>'receipt_id' = p_receipt::text;
  perform pms_log(f.property_id, 'fiscal.manual', 'fiscal_receipt', p_receipt, jsonb_build_object('receipt_no', p_receipt_no));
end $$;

create or replace function pms_retry_job(p_job bigint) returns void
language plpgsql security definer set search_path = public as $$
declare j pms_jobs;
begin
  select * into j from pms_jobs where id = p_job;
  if not found then raise exception 'Job not found'; end if;
  perform pms_require(j.property_id, array['owner','manager']);
  if j.status not in ('failed') then raise exception 'Only failed jobs can be retried'; end if;
  update pms_jobs set status = 'queued', attempts = 0, run_after = now(), updated_at = now() where id = p_job;
end $$;

-- Push the next year of availability and rates (after first mapping, or to resync)
create or replace function pms_channex_full_sync(p_property uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_bd date;
begin
  perform pms_require(p_property, array['owner','manager']);
  if not pms__integration_on(p_property, 'channex') then raise exception 'Turn Channex on first'; end if;
  select business_date into v_bd from pms_properties where id = p_property;
  perform pms__enqueue_ari(p_property, v_bd, v_bd + 500);
  perform pms__enqueue(p_property, 'channex', 'pull_bookings', '{}'::jsonb, 'channex:pull:' || p_property);
end $$;

-- Revenue assurance: room-by-room, day-by-day comparison of PMS occupancy with door and camera activity
create or replace function pms_rpt_revenue_assurance(p_property uuid, p_from date, p_to date)
returns table(day date, room_id uuid, room text, pms_status text, guest text, door_opens int, staff_opens int,
              camera_events int, first_activity timestamptz, last_activity timestamptz, flag text)
language plpgsql stable security definer set search_path = public as $$
declare v_tz text; v_staff text[]; v_bd date;
begin
  perform pms_require(p_property, array['owner','manager','accountant']);
  select timezone, business_date into v_tz, v_bd from pms_properties where id = p_property;
  select coalesce(array(select jsonb_array_elements_text(config->'staff_usernames')), '{}') into v_staff
    from pms_integrations where property_id = p_property and provider = 'ttlock';
  v_staff := coalesce(v_staff, '{}');
  return query
    with days as (select d::date as d from generate_series(p_from, p_to, interval '1 day') d),
    grid as (
      select days.d, r.id as room_id, r.number,
        (select s.status || '|' || pms__guest_name(g) from pms_stays s join pms_reservations rs on rs.id = s.reservation_id join pms_guests g on g.id = rs.guest_id
          where s.room_id = r.id and s.status in ('checked_in','checked_out') and s.arrival <= days.d and s.departure > days.d limit 1) as night,
        exists (select 1 from pms_stays s where s.room_id = r.id and s.status in ('checked_in','checked_out') and (s.arrival = days.d or s.departure = days.d)) as turnover,
        exists (select 1 from pms_maintenance_blocks b where b.room_id = r.id and b.status = 'active' and days.d >= b.from_date and days.d < b.to_date) as blocked
      from days cross join pms_rooms r where r.property_id = p_property and r.active),
    door as (
      select (e.event_time at time zone v_tz)::date as d, e.room_id,
        count(*) filter (where e.success and e.is_open and not (coalesce(e.username, '') = any(v_staff)))::int as guest_opens,
        count(*) filter (where e.success and e.is_open and coalesce(e.username, '') = any(v_staff))::int as staff_opens,
        min(e.event_time) as first_t, max(e.event_time) as last_t
      from pms_door_events e where e.property_id = p_property and e.room_id is not null
        and (e.event_time at time zone v_tz)::date between p_from and p_to
      group by 1, 2),
    cam as (
      select (c.event_time at time zone v_tz)::date as d, c.room_id, count(*)::int as n, min(c.event_time) as first_t, max(c.event_time) as last_t
      from pms_camera_events c where c.property_id = p_property and c.room_id is not null
        and (c.event_time at time zone v_tz)::date between p_from and p_to
      group by 1, 2)
    select g.d, g.room_id, g.number,
      case when g.night is not null then 'Occupied' when g.turnover then 'Arrival / departure' when g.blocked then 'Blocked' else 'Vacant' end,
      split_part(g.night, '|', 2),
      coalesce(door.guest_opens, 0), coalesce(door.staff_opens, 0), coalesce(cam.n, 0),
      least(door.first_t, cam.first_t), greatest(door.last_t, cam.last_t),
      case
        when g.night is null and not g.turnover and coalesce(door.guest_opens, 0) > 0 then 'Door used while vacant'
        when g.night is null and not g.turnover and coalesce(cam.n, 0) > 0 and coalesce(door.staff_opens, 0) = 0 then 'Movement while vacant'
        -- only for finished days, and only for rooms that actually have a lock or camera mapped
        when g.night is not null and g.d < v_bd and coalesce(door.guest_opens, 0) = 0 and coalesce(cam.n, 0) = 0
             and exists (select 1 from pms_external_ids x join pms_integrations i on i.property_id = x.property_id and i.provider = x.provider and i.enabled
                         where x.property_id = p_property and x.entity = 'room' and x.entity_id = g.room_id and x.provider in ('ttlock','hikvision')) then 'Occupied but no activity'
      end
    from grid g left join door on door.d = g.d and door.room_id = g.room_id left join cam on cam.d = g.d and cam.room_id = g.room_id
    order by g.d desc, g.number;
end $$;

-- ---------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['pms_jobs','pms_integration_log','pms_channex_rate_map','pms_channex_revisions','pms_door_events',
                           'pms_camera_events','pms_stay_passcodes','pms_fiscal_receipts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select using (pms_is_member(property_id))', t || '_read', t);
  end loop;
end $$;
drop policy if exists pms_channex_rate_map_write on pms_channex_rate_map;
create policy pms_channex_rate_map_write on pms_channex_rate_map for all
  using (pms_role(property_id) in ('owner','manager')) with check (pms_role(property_id) in ('owner','manager'));

grant select on pms_jobs, pms_integration_log, pms_channex_revisions, pms_door_events, pms_camera_events, pms_stay_passcodes, pms_fiscal_receipts to authenticated;
grant select, insert, update, delete on pms_channex_rate_map to authenticated;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'pms_svc_%' or p.proname like 'pms\_\_%' escape '\' or p.proname like 'pms_trg_%') loop
    execute format('revoke execute on function %s from public', f.sig);
    begin execute format('revoke execute on function %s from authenticated', f.sig); exception when undefined_object then null; end;
    begin execute format('revoke execute on function %s from anon', f.sig); exception when undefined_object then null; end;
  end loop;
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'pms_svc_%' loop
    begin execute format('grant execute on function %s to service_role', f.sig); exception when undefined_object then null; end;
  end loop;
end $$;

grant execute on function pms_fiscal_manual(uuid, text, text) to authenticated;
grant execute on function pms_retry_job(bigint) to authenticated;
grant execute on function pms_channex_full_sync(uuid) to authenticated;
grant execute on function pms_rpt_revenue_assurance(uuid, date, date) to authenticated;
-- pms__is_service and pms__require_service run inside definer functions only; helpers called from RLS stay callable
grant execute on function pms_role(uuid) to authenticated;
grant execute on function pms_is_member(uuid) to authenticated;
notify pgrst, 'reload schema';

-- Lock ids mapped to rooms, for the TTLock record pull
create or replace function pms_svc_lock_ids(p_property uuid) returns text[]
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_service();
  return array(select external_id from pms_external_ids where property_id = p_property and provider = 'ttlock' and entity = 'room' order by external_id);
end $$;
revoke execute on function pms_svc_lock_ids(uuid) from public;
do $$ begin execute 'revoke execute on function pms_svc_lock_ids(uuid) from authenticated'; exception when undefined_object then null; end $$;
do $$ begin execute 'grant execute on function pms_svc_lock_ids(uuid) to service_role'; exception when undefined_object then null; end $$;
