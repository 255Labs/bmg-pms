-- module: integrations
-- also: core
-- =====================================================================
-- BMG PMS 09 — platform: Tenda ICO gateway, Channex restrictions,
-- integration health, eZee import. Safe to re-run. Run after 08.
-- =====================================================================

alter table pms_integrations drop constraint if exists pms_integrations_provider_check;
alter table pms_integrations add constraint pms_integrations_provider_check
  check (provider in ('channex','ttlock','hikvision','fiscal','tendaico'));

-- ---------------------------------------------------------------------
-- 1. Channex restrictions (min stay, stop sell, closed to arrival/departure)
-- ---------------------------------------------------------------------
create table if not exists pms_rate_restrictions (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  room_type_id  uuid not null references pms_room_types(id) on delete cascade,
  rate_plan_id  uuid not null references pms_rate_plans(id) on delete cascade,
  rate_date     date not null,
  min_stay      int not null default 1 check (min_stay between 1 and 60),
  stop_sell     boolean not null default false,
  cta           boolean not null default false,   -- closed to arrival
  ctd           boolean not null default false,   -- closed to departure
  unique (room_type_id, rate_plan_id, rate_date)
);
create index if not exists idx_pms_restr on pms_rate_restrictions(property_id, rate_date);

create or replace function pms_trg_ari_restrictions() returns trigger
language plpgsql security definer set search_path = public as $$
declare r pms_rate_restrictions := coalesce(new, old);
begin
  perform pms__enqueue_ari(r.property_id, r.rate_date, r.rate_date + 1);
  return null;
end $$;
drop trigger if exists trg_ari_restrictions on pms_rate_restrictions;
create trigger trg_ari_restrictions after insert or update or delete on pms_rate_restrictions
  for each row execute function pms_trg_ari_restrictions();

-- Set (or clear, when everything is back to default) restrictions for a date range
create or replace function pms_set_restrictions(
  p_property uuid, p_room_type uuid, p_rate_plan uuid, p_from date, p_to date,
  p_min_stay int default 1, p_stop_sell boolean default false, p_cta boolean default false, p_ctd boolean default false
) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform pms_require(p_property, array['owner','manager']);
  if p_to < p_from then raise exception 'The end date is before the start date'; end if;
  if p_to - p_from > 730 then raise exception 'Set at most two years at a time'; end if;
  if not exists (select 1 from pms_room_types where id = p_room_type and property_id = p_property)
     or not exists (select 1 from pms_rate_plans where id = p_rate_plan and property_id = p_property) then
    raise exception 'Room type or rate plan not found';
  end if;
  if coalesce(p_min_stay, 1) = 1 and not p_stop_sell and not p_cta and not p_ctd then
    delete from pms_rate_restrictions where room_type_id = p_room_type and rate_plan_id = p_rate_plan and rate_date between p_from and p_to;
  else
    insert into pms_rate_restrictions(property_id, room_type_id, rate_plan_id, rate_date, min_stay, stop_sell, cta, ctd)
    select p_property, p_room_type, p_rate_plan, d::date, coalesce(p_min_stay, 1), p_stop_sell, p_cta, p_ctd
    from generate_series(p_from, p_to, interval '1 day') d
    on conflict (room_type_id, rate_plan_id, rate_date) do update
      set min_stay = excluded.min_stay, stop_sell = excluded.stop_sell, cta = excluded.cta, ctd = excluded.ctd;
  end if;
  get diagnostics n = row_count;
  perform pms_log(p_property, 'rates.restrictions', 'rate_plan', p_rate_plan,
    jsonb_build_object('room_type_id', p_room_type, 'from', p_from, 'to', p_to, 'min_stay', p_min_stay,
                       'stop_sell', p_stop_sell, 'cta', p_cta, 'ctd', p_ctd));
  return p_to - p_from + 1;
end $$;

-- The ARI snapshot now carries restrictions next to each rate
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
      'rate', pms_rate(m.room_type_id, m.rate_plan_id, d::date),
      'min_stay', coalesce(r.min_stay, 1), 'stop_sell', coalesce(r.stop_sell, false),
      'cta', coalesce(r.cta, false), 'ctd', coalesce(r.ctd, false)) order by m.channex_rate_plan_id, d), '[]'::jsonb)
    into v_rates
  from pms_channex_rate_map m cross join generate_series(p_from, p_to - 1, interval '1 day') d
  left join pms_rate_restrictions r on r.room_type_id = m.room_type_id and r.rate_plan_id = m.rate_plan_id and r.rate_date = d::date
  where m.property_id = p_property;

  return jsonb_build_object('availability', v_avail, 'rates', v_rates);
end $$;

-- ---------------------------------------------------------------------
-- 2. Tenda ICO (or any outside POS): API keys and room charges
-- ---------------------------------------------------------------------
create table if not exists pms_api_keys (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references pms_properties(id) on delete cascade,
  provider      text not null default 'tendaico' check (provider in ('tendaico')),
  name          text not null,
  prefix        text not null,             -- first characters, to recognise a key on screen
  key_hash      text not null unique,      -- sha256 of the key; the key itself is never stored
  created_by    uuid,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

create table if not exists pms_external_charges (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references pms_properties(id) on delete cascade,
  source         text not null,             -- 'tendaico'
  external_ref   text not null,             -- the POS bill id; the idempotency key
  outlet         text,
  stay_id        uuid not null references pms_stays(id),
  folio_id       uuid not null references pms_folios(id),
  folio_line_id  uuid not null references pms_folio_lines(id),
  amount         numeric(14,2) not null,
  description    text not null,
  items          jsonb,
  status         text not null default 'posted' check (status in ('posted','voided')),
  created_at     timestamptz not null default now(),
  voided_at      timestamptz,
  void_reason    text,
  unique (property_id, source, external_ref)
);
create index if not exists idx_pms_ext_charges on pms_external_charges(property_id, created_at);

-- Make a key; the plain key is returned once and never again
create or replace function pms_create_api_key(p_property uuid, p_name text, p_provider text default 'tendaico')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_key text; v_id uuid;
begin
  perform pms_require(p_property, array['owner','manager']);
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the key a name, such as the outlet or till'; end if;
  v_key := 'bmgpms_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into pms_api_keys(property_id, provider, name, prefix, key_hash, created_by)
  values (p_property, p_provider, trim(p_name), left(v_key, 14), encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), auth.uid())
  returning id into v_id;
  perform pms_log(p_property, 'api_key.create', 'api_key', v_id, jsonb_build_object('name', p_name, 'provider', p_provider));
  return jsonb_build_object('id', v_id, 'key', v_key, 'prefix', left(v_key, 14));
end $$;

create or replace function pms_revoke_api_key(p_key uuid) returns void
language plpgsql security definer set search_path = public as $$
declare k pms_api_keys;
begin
  select * into k from pms_api_keys where id = p_key;
  if not found then raise exception 'Key not found'; end if;
  perform pms_require(k.property_id, array['owner','manager']);
  update pms_api_keys set revoked_at = coalesce(revoked_at, now()) where id = p_key;
  perform pms_log(k.property_id, 'api_key.revoke', 'api_key', p_key, jsonb_build_object('name', k.name));
end $$;

-- Gateway: which property does this key belong to?
create or replace function pms_svc_api_key_check(p_key text, p_provider text default 'tendaico')
returns table(property_id uuid, key_id uuid, key_name text)
language plpgsql security definer set search_path = public as $$
begin
  perform pms__require_service();
  return query
    update pms_api_keys k set last_used_at = now()
    where k.key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
      and k.provider = p_provider and k.revoked_at is null
    returning k.property_id, k.id, k.name;
end $$;

-- In-house guests a cashier can charge to
create or replace function pms_svc_pos_inhouse(p_property uuid, p_query text default null)
returns table(stay_id uuid, room text, guest text, last_name text, arrival date, departure date, balance numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_service();
  return query
    select s.id, r.number, pms__guest_name(g), g.last_name, s.arrival, s.departure,
           coalesce((select sum(b.balance) from pms_folio_balances b join pms_folios f2 on f2.id = b.folio_id where f2.stay_id = s.id), 0)
    from pms_stays s
    join pms_rooms r on r.id = s.room_id
    join pms_reservations rs on rs.id = s.reservation_id
    join pms_guests g on g.id = rs.guest_id
    where s.property_id = p_property and s.status = 'checked_in'
      and (p_query is null or r.number ilike p_query || '%' or g.last_name ilike '%' || p_query || '%' or g.first_name ilike '%' || p_query || '%')
    order by r.number;
end $$;

-- Charge a POS bill to a room. Same (source, external_ref) twice = the first result, never a second charge.
create or replace function pms_svc_pos_charge(
  p_property uuid, p_source text, p_ref text, p_stay uuid, p_room text, p_amount numeric,
  p_category text default 'fnb', p_outlet text default null, p_description text default null, p_items jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s pms_stays; v_room text; v_folio uuid; v_line uuid; v_bd date; x pms_external_charges; v_desc text;
begin
  perform pms__require_service();
  if coalesce(trim(p_ref), '') = '' then raise exception 'BAD_REQUEST: bill reference is required'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'BAD_REQUEST: amount must be greater than zero'; end if;
  if p_category not in ('fnb','laundry','minibar','transport','spa','damage','other') then
    raise exception 'BAD_REQUEST: unknown category %', p_category;
  end if;

  select * into x from pms_external_charges where property_id = p_property and source = p_source and external_ref = p_ref;
  if found then
    if x.amount <> round(p_amount, 2) then
      raise exception 'CONFLICT: bill % was already charged with a different amount (%)', p_ref, x.amount;
    end if;
    return jsonb_build_object('status', x.status, 'duplicate', true, 'charge_id', x.id, 'folio_line_id', x.folio_line_id, 'amount', x.amount);
  end if;

  select * into s from pms_stays where id = p_stay and property_id = p_property for update;
  if not found or s.status <> 'checked_in' then raise exception 'NOT_IN_HOUSE: this guest is not checked in'; end if;
  select number into v_room from pms_rooms where id = s.room_id;
  if p_room is not null and p_room <> v_room then
    raise exception 'ROOM_MISMATCH: the guest moved to room %; refresh the guest list', v_room;
  end if;
  select id into v_folio from pms_folios where stay_id = s.id and status = 'open' order by folio_no limit 1;
  if v_folio is null then raise exception 'NOT_IN_HOUSE: this guest has no open folio'; end if;
  select business_date into v_bd from pms_properties where id = p_property;

  v_desc := coalesce(nullif(trim(p_description), ''), coalesce(p_outlet, 'POS') || ' bill ' || p_ref);
  insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount, reference, business_date, source)
  values (p_property, v_folio, s.id, 'charge', p_category, v_desc, round(p_amount, 2), p_source || ':' || p_ref, v_bd, 'pos')
  returning id into v_line;
  insert into pms_external_charges(property_id, source, external_ref, outlet, stay_id, folio_id, folio_line_id, amount, description, items)
  values (p_property, p_source, p_ref, p_outlet, s.id, v_folio, v_line, round(p_amount, 2), v_desc, p_items)
  returning * into x;
  perform pms_log(p_property, 'pos.external_charge', 'folio_line', v_line,
    jsonb_build_object('source', p_source, 'ref', p_ref, 'room', v_room, 'amount', p_amount, 'outlet', p_outlet));
  return jsonb_build_object('status', 'posted', 'duplicate', false, 'charge_id', x.id, 'folio_line_id', v_line, 'amount', x.amount, 'room', v_room);
end $$;

-- Void a room charge from the POS, same business day only (older ones go through the front desk)
create or replace function pms_svc_pos_void(p_property uuid, p_source text, p_ref text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x pms_external_charges; l pms_folio_lines; v_bd date;
begin
  perform pms__require_service();
  if coalesce(trim(p_reason), '') = '' then raise exception 'BAD_REQUEST: a reason is required'; end if;
  select * into x from pms_external_charges where property_id = p_property and source = p_source and external_ref = p_ref for update;
  if not found then raise exception 'NOT_FOUND: no room charge for bill %', p_ref; end if;
  if x.status = 'voided' then return jsonb_build_object('status', 'voided', 'duplicate', true); end if;
  select * into l from pms_folio_lines where id = x.folio_line_id;
  select business_date into v_bd from pms_properties where id = p_property;
  if l.business_date <> v_bd then
    raise exception 'DAY_CLOSED: this charge is from %, which the night audit has closed; ask the front desk to adjust it', l.business_date;
  end if;
  if exists (select 1 from pms_folios where id = x.folio_id and status <> 'open') then
    raise exception 'DAY_CLOSED: the guest has checked out; ask the front desk to adjust it';
  end if;
  update pms_folio_lines set voided = true, void_reason = p_source || ': ' || p_reason, voided_at = now() where id = x.folio_line_id;
  update pms_external_charges set status = 'voided', voided_at = now(), void_reason = p_reason where id = x.id;
  perform pms_log(p_property, 'pos.external_void', 'folio_line', x.folio_line_id,
    jsonb_build_object('source', p_source, 'ref', p_ref, 'amount', x.amount, 'reason', p_reason));
  return jsonb_build_object('status', 'voided', 'duplicate', false);
end $$;

-- ---------------------------------------------------------------------
-- 3. Integration health: one row per service, green / amber / red
-- ---------------------------------------------------------------------
create or replace function pms_integration_health(p_property uuid)
returns table(provider text, enabled boolean, status text, last_ok_at timestamptz, last_error text,
              failed_jobs int, queued_jobs int, oldest_queued_minutes int, detail text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare pr text; v_on boolean; v_ok timestamptz; v_err text; v_errat timestamptz; v_failed int; v_queued int; v_age int;
        v_status text; v_detail text; v_last_event timestamptz; v_stale int;
begin
  if not pms_is_member(p_property) then raise exception 'Not a member of this property'; end if;
  foreach pr in array array['channex','ttlock','hikvision','fiscal','tendaico'] loop
    select coalesce(i.enabled, false) into v_on from pms_integrations i where i.property_id = p_property and i.provider = pr;
    v_on := coalesce(v_on, false);
    select max(created_at) into v_ok from pms_integration_log where property_id = p_property and provider = pr and ok;
    select l.error, l.created_at into v_err, v_errat from pms_integration_log l
      where l.property_id = p_property and l.provider = pr and not l.ok
        -- a request the PMS turned down on purpose (guest not in house, wrong amount) is not an outage
        and not coalesce(l.status_code between 400 and 499 and l.status_code not in (401, 403), false)
      order by l.created_at desc limit 1;
    select count(*) filter (where j.status = 'failed')::int, count(*) filter (where j.status in ('queued','running'))::int,
           coalesce(extract(epoch from now() - min(j.created_at) filter (where j.status in ('queued','running'))) / 60, 0)::int
      into v_failed, v_queued, v_age
      from pms_jobs j where j.property_id = p_property and j.provider = pr;
    v_detail := null;
    v_stale := case pr when 'channex' then 30 when 'ttlock' then 30 when 'hikvision' then 1440 else null end;

    if pr = 'hikvision' then
      select max(event_time) into v_last_event from pms_camera_events where property_id = p_property;
      v_ok := greatest(v_ok, v_last_event);
    elsif pr = 'tendaico' then
      select max(last_used_at) into v_ok from pms_api_keys where property_id = p_property and provider = 'tendaico';
      v_on := v_on or exists (select 1 from pms_api_keys where property_id = p_property and provider = 'tendaico' and revoked_at is null);
    end if;

    if not v_on then v_status := 'off';
    elsif v_failed > 0 then v_status := 'error'; v_detail := v_failed || ' task(s) failed and need a retry';
    elsif v_err is not null and (v_ok is null or v_errat > v_ok) then v_status := 'error'; v_detail := 'Last call failed: ' || left(v_err, 160);
    elsif v_age > 15 then v_status := 'warning'; v_detail := 'Tasks waiting ' || v_age || ' minutes; is the schedule running?';
    elsif v_stale is not null and (v_ok is null or v_ok < now() - make_interval(mins => v_stale)) then
      v_status := 'warning';
      v_detail := case when v_ok is null then 'No successful contact yet'
                       else 'No successful contact for ' || (extract(epoch from now() - v_ok) / 60)::int || ' minutes' end;
    else v_status := 'ok';
    end if;

    provider := pr; enabled := v_on; status := v_status; last_ok_at := v_ok;
    last_error := case when v_err is not null and (v_ok is null or v_errat > v_ok) then v_err end;
    failed_jobs := coalesce(v_failed, 0); queued_jobs := coalesce(v_queued, 0); oldest_queued_minutes := coalesce(v_age, 0); detail := v_detail;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Moving from eZee: guests and reservations from CSV exports
-- ---------------------------------------------------------------------
create table if not exists pms_import_runs (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  kind         text not null check (kind in ('guests','reservations')),
  file_name    text,
  total        int not null default 0,
  imported     int not null default 0,
  skipped      int not null default 0,
  failed       int not null default 0,
  results      jsonb,
  created_by   uuid,
  created_at   timestamptz not null default now()
);

create or replace function pms__norm_phone(p text) returns text
language sql immutable as $$ select nullif(regexp_replace(coalesce(p, ''), '[^0-9+]', '', 'g'), '') $$;

create or replace function pms_import_guests(p_property uuid, p_rows jsonb, p_file text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; i int := 0; v_ok int := 0; v_skip int := 0; v_fail int := 0; v_out jsonb := '[]'; v_id uuid; v_phone text; v_email text;
begin
  perform pms_require(p_property, array['owner','manager']);
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Rows must be a list'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Import at most 5,000 rows at a time'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      if coalesce(trim(r->>'first_name'), '') = '' and coalesce(trim(r->>'last_name'), '') = '' then
        raise exception 'No name';
      end if;
      v_phone := pms__norm_phone(r->>'phone');
      v_email := nullif(lower(trim(coalesce(r->>'email', ''))), '');
      select id into v_id from pms_guests where property_id = p_property
        and ((v_phone is not null and pms__norm_phone(phone) = v_phone) or (v_email is not null and lower(email) = v_email)) limit 1;
      if v_id is not null then
        v_skip := v_skip + 1;
        v_out := v_out || jsonb_build_object('row', i, 'status', 'skipped', 'message', 'Already in the guest database');
      else
        insert into pms_guests(property_id, title, first_name, last_name, phone, email, nationality, id_type, id_number)
        values (p_property, nullif(trim(r->>'title'), ''), coalesce(nullif(trim(r->>'first_name'), ''), trim(r->>'last_name')),
                case when nullif(trim(r->>'first_name'), '') is null then null else nullif(trim(r->>'last_name'), '') end,
                v_phone, v_email, nullif(trim(r->>'nationality'), ''), nullif(trim(r->>'id_type'), ''), nullif(trim(r->>'id_number'), ''));
        v_ok := v_ok + 1;
        v_out := v_out || jsonb_build_object('row', i, 'status', 'imported');
      end if;
    exception when others then
      v_fail := v_fail + 1;
      v_out := v_out || jsonb_build_object('row', i, 'status', 'failed', 'message', sqlerrm);
    end;
  end loop;
  insert into pms_import_runs(property_id, kind, file_name, total, imported, skipped, failed, results, created_by)
  values (p_property, 'guests', p_file, i, v_ok, v_skip, v_fail, v_out, auth.uid());
  perform pms_log(p_property, 'import.guests', 'property', p_property, jsonb_build_object('file', p_file, 'imported', v_ok, 'skipped', v_skip, 'failed', v_fail));
  return jsonb_build_object('total', i, 'imported', v_ok, 'skipped', v_skip, 'failed', v_fail, 'rows', v_out);
end $$;

-- Rows: ezee_no, first_name, last_name, phone, email, arrival, departure, room_type, room, adults, children,
--       rate, source, status (confirmed | tentative | in_house), deposit, balance, notes
-- Each row is its own transaction: one bad row never stops the rest. Re-running skips rows already imported.
create or replace function pms_import_reservations(p_property uuid, p_rows jsonb, p_file text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p pms_properties; r jsonb; i int := 0; v_ok int := 0; v_skip int := 0; v_fail int := 0; v_out jsonb := '[]';
  v_ref text; v_type uuid; v_room uuid; v_src uuid; v_arr date; v_dep date; v_status text; v_res jsonb; v_stay uuid;
  v_folio uuid; v_amt numeric; v_guest uuid; v_phone text;
begin
  perform pms_require(p_property, array['owner','manager']);
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Rows must be a list'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Import at most 5,000 rows at a time'; end if;
  select * into p from pms_properties where id = p_property;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      v_ref := 'ezee:' || nullif(trim(r->>'ezee_no'), '');
      if v_ref is null then raise exception 'eZee reservation number is missing'; end if;
      if exists (select 1 from pms_reservations where property_id = p_property and external_ref = v_ref) then
        v_skip := v_skip + 1;
        v_out := v_out || jsonb_build_object('row', i, 'ref', r->>'ezee_no', 'status', 'skipped', 'message', 'Already imported');
        continue;
      end if;
      v_arr := (r->>'arrival')::date; v_dep := (r->>'departure')::date;
      v_status := lower(coalesce(nullif(trim(r->>'status'), ''), 'confirmed'));
      v_status := case when v_status in ('in_house','in house','checked_in','checked in','arrived') then 'in_house'
                       when v_status in ('tentative','unconfirmed') then 'tentative' else 'confirmed' end;
      if v_dep <= p.business_date then raise exception 'Departure % is before the business date; past stays are not imported', v_dep; end if;
      if v_status <> 'in_house' and v_arr < p.business_date then
        raise exception 'Arrival % is before the business date but the guest is not marked in house', v_arr;
      end if;

      v_room := null; v_type := null;
      if nullif(trim(r->>'room'), '') is not null then
        select id, room_type_id into v_room, v_type from pms_rooms where property_id = p_property and number = trim(r->>'room');
        if v_room is null then raise exception 'Room % does not exist', r->>'room'; end if;
      end if;
      if v_type is null then
        select id into v_type from pms_room_types where property_id = p_property and lower(name) = lower(trim(coalesce(r->>'room_type', '')));
        if v_type is null then raise exception 'Room type "%" does not exist; add it in Setup or fix the file', r->>'room_type'; end if;
      end if;
      if v_status = 'in_house' and v_room is null then raise exception 'In-house guests need a room number'; end if;
      select id into v_src from pms_business_sources where property_id = p_property and lower(name) = lower(trim(coalesce(r->>'source', '')));

      -- an existing guest with the same phone is reused
      v_phone := pms__norm_phone(r->>'phone');
      select id into v_guest from pms_guests where property_id = p_property and v_phone is not null and pms__norm_phone(phone) = v_phone limit 1;

      v_res := pms_create_reservation(p_property,
        case when v_guest is not null then jsonb_build_object('id', v_guest)
             else jsonb_build_object('first_name', coalesce(nullif(trim(r->>'first_name'), ''), trim(r->>'last_name')),
                    'last_name', case when nullif(trim(r->>'first_name'), '') is null then null else r->>'last_name' end,
                    'phone', v_phone, 'email', r->>'email') end,
        greatest(v_arr, p.business_date), v_dep,
        jsonb_build_array(jsonb_build_object('room_id', v_room, 'room_type_id', v_type,
          'adults', coalesce(nullif(r->>'adults', '')::int, 1), 'children', coalesce(nullif(r->>'children', '')::int, 0),
          'rate', nullif(r->>'rate', '')::numeric)),
        v_src, null, null, case when v_status = 'tentative' then 'tentative' else 'confirmed' end,
        nullif(trim(coalesce(r->>'notes', '')), ''), v_ref);
      select id into v_stay from pms_stays where reservation_id = (v_res->>'reservation_id')::uuid;
      select id into v_folio from pms_folios where stay_id = v_stay;

      if v_status = 'in_house' then
        update pms_stays set arrival = v_arr, status = 'checked_in', checked_in_at = now() where id = v_stay;
        update pms_reservations set arrival = v_arr where id = (v_res->>'reservation_id')::uuid;
        perform pms__refresh_reservation((v_res->>'reservation_id')::uuid);
        v_amt := coalesce(nullif(r->>'balance', '')::numeric, 0);
        if v_amt > 0 then
          insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount, reference, business_date, source)
          values (p_property, v_folio, v_stay, 'charge', 'other', 'Balance brought forward from eZee', round(v_amt, 2), v_ref, p.business_date, 'system');
        elsif v_amt < 0 then
          insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount, payment_method, reference, business_date, source)
          values (p_property, v_folio, v_stay, 'payment', 'payment', 'Credit brought forward from eZee', round(v_amt, 2), 'other', v_ref, p.business_date, 'system');
        end if;
      end if;
      v_amt := coalesce(nullif(r->>'deposit', '')::numeric, 0);
      if v_amt > 0 and v_status <> 'in_house' then
        insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount, payment_method, reference, business_date, source)
        values (p_property, v_folio, v_stay, 'payment', 'payment', 'Deposit paid in eZee', -round(v_amt, 2), 'other', v_ref, p.business_date, 'system');
      end if;

      v_ok := v_ok + 1;
      v_out := v_out || jsonb_build_object('row', i, 'ref', r->>'ezee_no', 'status', 'imported', 'res_no', v_res->'res_no');
    exception when others then
      v_fail := v_fail + 1;
      v_out := v_out || jsonb_build_object('row', i, 'ref', r->>'ezee_no', 'status', 'failed', 'message', sqlerrm);
    end;
  end loop;
  insert into pms_import_runs(property_id, kind, file_name, total, imported, skipped, failed, results, created_by)
  values (p_property, 'reservations', p_file, i, v_ok, v_skip, v_fail, v_out, auth.uid());
  perform pms_log(p_property, 'import.reservations', 'property', p_property, jsonb_build_object('file', p_file, 'imported', v_ok, 'skipped', v_skip, 'failed', v_fail));
  return jsonb_build_object('total', i, 'imported', v_ok, 'skipped', v_skip, 'failed', v_fail, 'rows', v_out);
end $$;

-- ---------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------
alter table pms_rate_restrictions enable row level security;
drop policy if exists pms_rate_restrictions_read on pms_rate_restrictions;
create policy pms_rate_restrictions_read on pms_rate_restrictions for select using (pms_is_member(property_id));
grant select on pms_rate_restrictions to authenticated;
revoke insert, update, delete on pms_rate_restrictions from authenticated;

alter table pms_api_keys enable row level security;
drop policy if exists pms_api_keys_read on pms_api_keys;
create policy pms_api_keys_read on pms_api_keys for select using (pms_role(property_id) in ('owner','manager'));
revoke all on pms_api_keys from authenticated;
grant select (id, property_id, provider, name, prefix, created_at, last_used_at, revoked_at) on pms_api_keys to authenticated;

alter table pms_external_charges enable row level security;
drop policy if exists pms_external_charges_read on pms_external_charges;
create policy pms_external_charges_read on pms_external_charges for select using (pms_is_member(property_id));
revoke all on pms_external_charges from authenticated;
grant select on pms_external_charges to authenticated;

alter table pms_import_runs enable row level security;
drop policy if exists pms_import_runs_read on pms_import_runs;
create policy pms_import_runs_read on pms_import_runs for select using (pms_role(property_id) in ('owner','manager'));
revoke all on pms_import_runs from authenticated;
grant select on pms_import_runs to authenticated;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'pms_svc_%' or p.proname like 'pms\_\_%' escape '\' or p.proname like 'pms_trg_%') loop
    execute format('revoke execute on function %s from public', f.sig);
    begin execute format('revoke execute on function %s from authenticated', f.sig); exception when undefined_object then null; end;
    begin execute format('revoke execute on function %s from anon', f.sig); exception when undefined_object then null; end;
    if f.sig::text like 'pms_svc_%' then
      begin execute format('grant execute on function %s to service_role', f.sig); exception when undefined_object then null; end;
    end if;
  end loop;
end $$;
grant execute on function pms_set_restrictions(uuid, uuid, uuid, date, date, int, boolean, boolean, boolean) to authenticated;
grant execute on function pms_create_api_key(uuid, text, text) to authenticated;
grant execute on function pms_revoke_api_key(uuid) to authenticated;
grant execute on function pms_integration_health(uuid) to authenticated;
grant execute on function pms_import_guests(uuid, jsonb, text) to authenticated;
grant execute on function pms_import_reservations(uuid, jsonb, text) to authenticated;
grant execute on function pms_role(uuid) to authenticated;
grant execute on function pms_is_member(uuid) to authenticated;
notify pgrst, 'reload schema';
