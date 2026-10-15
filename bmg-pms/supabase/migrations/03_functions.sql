-- module: front-office
-- =====================================================================
-- BMG PMS — 03 FUNCTIONS: setup, reservations, front desk, cashiering,
-- housekeeping. Every write that touches money or stays goes through here.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Property setup
-- ---------------------------------------------------------------------
-- p_room_setup example:
-- [{"name":"Single","code":"SGL","base_rate":200000,"max_occupancy":1,"rooms":["331","332"]}]
create or replace function pms_create_property(
  p_name text, p_code text default null, p_display_name text default null,
  p_room_setup jsonb default '[]'::jsonb, p_tax_inclusive boolean default true
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_rt jsonb; v_type uuid; v_room text; v_i int := 0;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'Property name is required'; end if;

  insert into pms_properties(name, code, tax_inclusive)
  values (trim(p_name), nullif(upper(trim(p_code)),''), p_tax_inclusive) returning id into v_id;

  insert into pms_members(property_id, user_id, role, display_name)
  values (v_id, auth.uid(), 'owner', p_display_name);

  insert into pms_rate_plans(property_id, name, meal_plan) values
    (v_id, 'Room Only', 'RO'), (v_id, 'Bed & Breakfast', 'BB');

  insert into pms_business_sources(property_id, name, kind) values
    (v_id,'Walk-in','walk_in'), (v_id,'Direct / Phone','direct'), (v_id,'Website','direct'),
    (v_id,'Booking.com','ota'), (v_id,'Expedia','ota'), (v_id,'Airbnb','ota'),
    (v_id,'Travel Agent','travel_agent'), (v_id,'Corporate','company');

  for v_rt in select * from jsonb_array_elements(coalesce(p_room_setup,'[]'::jsonb)) loop
    v_i := v_i + 1;
    insert into pms_room_types(property_id, name, code, base_rate, max_occupancy, sort_order)
    values (v_id, v_rt->>'name', v_rt->>'code', coalesce((v_rt->>'base_rate')::numeric,0),
            coalesce((v_rt->>'max_occupancy')::int,2), v_i)
    returning id into v_type;
    for v_room in select jsonb_array_elements_text(coalesce(v_rt->'rooms','[]'::jsonb)) loop
      insert into pms_rooms(property_id, room_type_id, number) values (v_id, v_type, trim(v_room));
    end loop;
  end loop;

  perform pms_log(v_id, 'property.create', 'property', v_id, jsonb_build_object('name', p_name));
  return v_id;
end $$;

create or replace function pms_set_member(
  p_property uuid, p_email text, p_role text, p_display_name text default null, p_active boolean default true
) returns void
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  perform pms_require(p_property, array['owner']);
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'No account for %. Ask them to sign up first, then add them.', p_email;
  end if;
  if v_user = auth.uid() and (p_role <> 'owner' or not p_active) then
    raise exception 'You cannot demote or deactivate yourself';
  end if;
  insert into pms_members(property_id, user_id, role, display_name, active)
  values (p_property, v_user, p_role, p_display_name, p_active)
  on conflict (property_id, user_id) do update
    set role = excluded.role, display_name = coalesce(excluded.display_name, pms_members.display_name),
        active = excluded.active;
  perform pms_log(p_property, 'member.set', 'member', v_user,
    jsonb_build_object('email', p_email, 'role', p_role, 'active', p_active));
end $$;

create or replace function pms_list_members(p_property uuid)
returns table(user_id uuid, email text, display_name text, role text, active boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property);
  return query
    select m.user_id, u.email::text, m.display_name, m.role, m.active
    from pms_members m join auth.users u on u.id = m.user_id
    where m.property_id = p_property order by m.role, u.email;
end $$;

-- ---------------------------------------------------------------------
-- Rates and availability
-- ---------------------------------------------------------------------
create or replace function pms_rate(p_room_type uuid, p_rate_plan uuid, p_date date)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(
    (select amount from pms_rates where room_type_id = p_room_type
       and rate_plan_id = p_rate_plan and rate_date = p_date),
    (select base_rate from pms_room_types where id = p_room_type), 0)
$$;

-- Rooms of a type still sellable on a night (rooms - stays - blocks)
create or replace function pms_type_availability(p_room_type uuid, p_date date)
returns integer language sql stable security definer set search_path = public as $$
  select
    (select count(*) from pms_rooms r where r.room_type_id = p_room_type and r.active)::int
  - (select count(*) from pms_stays s where s.room_type_id = p_room_type
       and s.status in ('tentative','confirmed','checked_in')
       and p_date >= s.arrival and p_date < s.departure)::int
  - (select count(*) from pms_maintenance_blocks b join pms_rooms r on r.id = b.room_id
       where r.room_type_id = p_room_type and b.status = 'active'
       and p_date >= b.from_date and p_date < b.to_date)::int
$$;

create or replace function pms_availability(p_property uuid, p_from date, p_to date)
returns table(room_type_id uuid, room_type text, stay_date date, available integer, rate numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property);
  return query
    select t.id, t.name, d::date, pms_type_availability(t.id, d::date), t.base_rate
    from pms_room_types t
    cross join generate_series(p_from, p_to - 1, interval '1 day') d
    where t.property_id = p_property and t.active
    order by t.sort_order, t.name, d;
end $$;

-- Free physical rooms for a date range (for room assignment)
create or replace function pms_free_rooms(p_property uuid, p_arrival date, p_departure date, p_exclude_stay uuid default null)
returns table(room_id uuid, number text, room_type_id uuid, room_type text, hk_status text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property);
  return query
    select r.id, r.number, t.id, t.name, r.hk_status
    from pms_rooms r join pms_room_types t on t.id = r.room_type_id
    where r.property_id = p_property and r.active
      and not exists (select 1 from pms_stays s where s.room_id = r.id
          and s.status in ('tentative','confirmed','checked_in')
          and (p_exclude_stay is null or s.id <> p_exclude_stay)
          and daterange(s.arrival, s.departure) && daterange(p_arrival, p_departure))
      and not exists (select 1 from pms_maintenance_blocks b where b.room_id = r.id
          and b.status = 'active'
          and daterange(b.from_date, b.to_date) && daterange(p_arrival, p_departure))
    order by t.sort_order, r.number;
end $$;

-- ---------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------
create or replace function pms__next_folio_no(p_property uuid) returns integer
language sql security definer set search_path = public as $$
  update pms_properties set next_folio_no = next_folio_no + 1
  where id = p_property returning next_folio_no - 1
$$;

create or replace function pms__refresh_reservation(p_reservation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_statuses text[]; v_new text;
begin
  select array_agg(distinct status) into v_statuses from pms_stays where reservation_id = p_reservation;
  if v_statuses is null then return; end if;
  if array_length(v_statuses,1) = 1 then
    v_new := v_statuses[1];
  elsif 'checked_in' = any(v_statuses) then
    v_new := 'checked_in';
  elsif v_statuses <@ array['checked_out','cancelled','no_show'] then
    v_new := case when 'checked_out' = any(v_statuses) then 'checked_out' else 'cancelled' end;
  else
    v_new := 'partial';
  end if;
  update pms_reservations set
    status = v_new,
    arrival = (select min(arrival) from pms_stays where reservation_id = p_reservation),
    departure = (select max(departure) from pms_stays where reservation_id = p_reservation)
  where id = p_reservation;
end $$;

create or replace function pms__stay(p_stay uuid) returns pms_stays
language plpgsql security definer set search_path = public as $$
declare v pms_stays;
begin
  select * into v from pms_stays where id = p_stay for update;
  if not found then raise exception 'Stay not found'; end if;
  return v;
end $$;

create or replace function pms__friendly(p_err text) returns text language sql immutable as $$
  select case when p_err like '%pms_stays_no_double_booking%'
              then 'That room is already booked for some of those nights'
              when p_err like '%pms_blocks_no_overlap%'
              then 'That room already has a maintenance block on those dates'
              else p_err end
$$;

-- ---------------------------------------------------------------------
-- Reservations
-- ---------------------------------------------------------------------
-- p_guest: {"id": "..."} OR {"title","first_name","last_name","phone","email","nationality","id_type","id_number"}
-- p_rooms: [{"room_type_id":"...","room_id":"...|null","rate":200000|null,"adults":1,"children":0}]
create or replace function pms_create_reservation(
  p_property uuid, p_guest jsonb, p_arrival date, p_departure date, p_rooms jsonb,
  p_source_id uuid default null, p_rate_plan_id uuid default null, p_company_id uuid default null,
  p_status text default 'confirmed', p_notes text default null, p_external_ref text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_prop pms_properties; v_guest uuid; v_res uuid; v_res_no int; v_line jsonb;
  v_stay uuid; v_type uuid; v_room uuid; v_rate numeric; v_min int; v_plan uuid;
begin
  perform pms_require(p_property, array['owner','manager','front_desk']);
  select * into v_prop from pms_properties where id = p_property for update;

  if p_departure <= p_arrival then raise exception 'Departure must be after arrival'; end if;
  if p_arrival < v_prop.business_date then
    raise exception 'Arrival (%) is before the business date (%)', p_arrival, v_prop.business_date;
  end if;
  if p_status not in ('confirmed','tentative') then raise exception 'Status must be confirmed or tentative'; end if;
  if jsonb_array_length(coalesce(p_rooms,'[]'::jsonb)) = 0 then raise exception 'Add at least one room'; end if;

  v_plan := coalesce(p_rate_plan_id,
    (select id from pms_rate_plans where property_id = p_property and active order by name limit 1));

  -- Guest
  if p_guest ? 'id' and nullif(p_guest->>'id','') is not null then
    select id into v_guest from pms_guests where id = (p_guest->>'id')::uuid and property_id = p_property;
    if v_guest is null then raise exception 'Guest not found'; end if;
  else
    if coalesce(trim(p_guest->>'first_name'),'') = '' then raise exception 'Guest first name is required'; end if;
    insert into pms_guests(property_id, title, first_name, last_name, phone, email, nationality, id_type, id_number)
    values (p_property, p_guest->>'title', trim(p_guest->>'first_name'), nullif(trim(p_guest->>'last_name'),''),
            p_guest->>'phone', p_guest->>'email', p_guest->>'nationality', p_guest->>'id_type', p_guest->>'id_number')
    returning id into v_guest;
  end if;

  v_res_no := v_prop.next_res_no;
  update pms_properties set next_res_no = next_res_no + 1 where id = p_property;

  insert into pms_reservations(property_id, res_no, guest_id, company_id, source_id, rate_plan_id,
                               status, arrival, departure, notes, external_ref, created_by)
  values (p_property, v_res_no, v_guest, p_company_id, p_source_id, v_plan,
          p_status, p_arrival, p_departure, p_notes, p_external_ref, auth.uid())
  returning id into v_res;

  for v_line in select * from jsonb_array_elements(p_rooms) loop
    v_room := nullif(v_line->>'room_id','')::uuid;
    v_type := nullif(v_line->>'room_type_id','')::uuid;
    if v_room is not null then
      select room_type_id into v_type from pms_rooms where id = v_room and property_id = p_property;
      if v_type is null then raise exception 'Room not found'; end if;
    end if;
    if v_type is null or not exists (select 1 from pms_room_types where id = v_type and property_id = p_property) then
      raise exception 'Room type is required for each room';
    end if;

    select min(pms_type_availability(v_type, d::date)) into v_min
    from generate_series(p_arrival, p_departure - 1, interval '1 day') d;
    if v_min < 1 then
      raise exception 'No % rooms left for some nights between % and %',
        (select name from pms_room_types where id = v_type), p_arrival, p_departure;
    end if;

    v_rate := coalesce(nullif(v_line->>'rate','')::numeric, pms_rate(v_type, v_plan, p_arrival));

    begin
      insert into pms_stays(property_id, reservation_id, room_type_id, room_id, arrival, departure,
                            adults, children, rate, status)
      values (p_property, v_res, v_type, v_room, p_arrival, p_departure,
              coalesce((v_line->>'adults')::int,1), coalesce((v_line->>'children')::int,0), v_rate, p_status)
      returning id into v_stay;
    exception when exclusion_violation then
      raise exception '%', pms__friendly(sqlerrm);
    end;

    insert into pms_folios(property_id, folio_no, reservation_id, stay_id, guest_id, company_id)
    values (p_property, pms__next_folio_no(p_property), v_res, v_stay, v_guest, p_company_id);
  end loop;

  perform pms_log(p_property, 'reservation.create', 'reservation', v_res,
    jsonb_build_object('res_no', v_res_no, 'arrival', p_arrival, 'departure', p_departure,
                       'rooms', jsonb_array_length(p_rooms)));
  return jsonb_build_object('reservation_id', v_res, 'res_no', v_res_no, 'guest_id', v_guest);
end $$;

create or replace function pms_assign_room(p_stay uuid, p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v pms_stays; v_type uuid; v_old text; v_new text;
begin
  v := pms__stay(p_stay);
  perform pms_require(v.property_id, array['owner','manager','front_desk']);
  if v.status not in ('tentative','confirmed','checked_in') then
    raise exception 'Cannot move a % stay', v.status;
  end if;
  select room_type_id, number into v_type, v_new from pms_rooms
  where id = p_room and property_id = v.property_id and active;
  if v_type is null then raise exception 'Room not found'; end if;
  select number into v_old from pms_rooms where id = v.room_id;
  begin
    update pms_stays set room_id = p_room, room_type_id = v_type where id = p_stay;
  exception when exclusion_violation then
    raise exception '%', pms__friendly(sqlerrm);
  end;
  -- room moved while in house: old room needs cleaning
  if v.status = 'checked_in' and v.room_id is not null and v.room_id <> p_room then
    update pms_rooms set hk_status = 'dirty' where id = v.room_id;
  end if;
  perform pms_log(v.property_id, 'stay.assign_room', 'stay', p_stay,
    jsonb_build_object('from', v_old, 'to', v_new));
end $$;

create or replace function pms_amend_stay(
  p_stay uuid, p_arrival date default null, p_departure date default null,
  p_rate numeric default null, p_adults int default null, p_children int default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v pms_stays; v_bd date; v_arr date; v_dep date; v_min int;
begin
  v := pms__stay(p_stay);
  perform pms_require(v.property_id, array['owner','manager','front_desk']);
  if v.status not in ('tentative','confirmed','checked_in') then
    raise exception 'Cannot amend a % stay', v.status;
  end if;
  select business_date into v_bd from pms_properties where id = v.property_id;
  v_arr := coalesce(p_arrival, v.arrival);
  v_dep := coalesce(p_departure, v.departure);
  if v.status = 'checked_in' and v_arr <> v.arrival then
    raise exception 'Arrival cannot change after check-in';
  end if;
  if v.status <> 'checked_in' and v_arr < v_bd then raise exception 'Arrival cannot be before the business date'; end if;
  if v_dep <= v_arr then raise exception 'Departure must be after arrival'; end if;
  if v.status = 'checked_in' and v_dep <= v_bd then
    raise exception 'Departure must be after the business date (%) for an in-house guest', v_bd;
  end if;

  -- Availability for unassigned stays (assigned stays are protected by the exclusion constraint)
  if v.room_id is null then
    select min(pms_type_availability(v.room_type_id, d::date)) into v_min
    from generate_series(v_arr, v_dep - 1, interval '1 day') d
    where not (d::date >= v.arrival and d::date < v.departure);
    if v_min is not null and v_min < 1 then raise exception 'No rooms of this type left for the new dates'; end if;
  end if;

  begin
    update pms_stays set arrival = v_arr, departure = v_dep,
      rate = coalesce(p_rate, rate), adults = coalesce(p_adults, adults), children = coalesce(p_children, children)
    where id = p_stay;
  exception when exclusion_violation then
    raise exception '%', pms__friendly(sqlerrm);
  end;
  perform pms__refresh_reservation(v.reservation_id);
  perform pms_log(v.property_id, 'stay.amend', 'stay', p_stay, jsonb_build_object(
    'arrival', v_arr, 'departure', v_dep, 'old_arrival', v.arrival, 'old_departure', v.departure,
    'rate', coalesce(p_rate, v.rate), 'old_rate', v.rate));
end $$;

create or replace function pms_cancel_stay(p_stay uuid, p_reason text, p_no_show boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare v pms_stays; v_bal numeric;
begin
  v := pms__stay(p_stay);
  perform pms_require(v.property_id, array['owner','manager','front_desk']);
  if v.status not in ('tentative','confirmed') then raise exception 'Only unchecked-in stays can be cancelled'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  update pms_stays set status = case when p_no_show then 'no_show' else 'cancelled' end where id = p_stay;
  -- close the folio if nothing is owed either way
  select b.balance into v_bal from pms_folios f join pms_folio_balances b on b.folio_id = f.id where f.stay_id = p_stay;
  if coalesce(v_bal,0) = 0 then update pms_folios set status = 'closed', closed_at = now() where stay_id = p_stay; end if;
  perform pms__refresh_reservation(v.reservation_id);
  perform pms_log(v.property_id, case when p_no_show then 'stay.no_show' else 'stay.cancel' end,
    'stay', p_stay, jsonb_build_object('reason', p_reason));
end $$;

-- ---------------------------------------------------------------------
-- Check-in / check-out
-- ---------------------------------------------------------------------
create or replace function pms_check_in(p_stay uuid, p_allow_dirty boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare v pms_stays; v_bd date; v_hk text;
begin
  v := pms__stay(p_stay);
  perform pms_require(v.property_id, array['owner','manager','front_desk']);
  if v.status not in ('tentative','confirmed') then raise exception 'Stay is %', v.status; end if;
  select business_date into v_bd from pms_properties where id = v.property_id;
  if v.arrival <> v_bd then
    raise exception 'Arrival is %, business date is %. Amend the dates to check in today.', v.arrival, v_bd;
  end if;
  if v.room_id is null then raise exception 'Assign a room before check-in'; end if;
  select hk_status into v_hk from pms_rooms where id = v.room_id;
  if v_hk = 'out_of_order' then raise exception 'Room is out of order'; end if;
  if v_hk = 'dirty' and not p_allow_dirty then raise exception 'ROOM_DIRTY: Room is dirty'; end if;

  update pms_stays set status = 'checked_in', checked_in_at = now() where id = p_stay;
  perform pms__refresh_reservation(v.reservation_id);
  perform pms_log(v.property_id, 'stay.check_in', 'stay', p_stay,
    jsonb_build_object('room_id', v.room_id, 'dirty_override', v_hk = 'dirty'));
end $$;

create or replace function pms_check_out(p_stay uuid, p_transfer_to_company boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare v pms_stays; v_bd date; v_folio pms_folios; v_bal numeric; v_company uuid;
begin
  v := pms__stay(p_stay);
  perform pms_require(v.property_id, array['owner','manager','front_desk']);
  if v.status <> 'checked_in' then raise exception 'Guest is not checked in'; end if;
  select business_date into v_bd from pms_properties where id = v.property_id;

  for v_folio in select * from pms_folios where stay_id = p_stay and status = 'open' loop
    select balance into v_bal from pms_folio_balances where folio_id = v_folio.id;
    if v_bal <> 0 then
      if p_transfer_to_company and v_bal > 0 then
        v_company := coalesce(v_folio.company_id,
          (select company_id from pms_reservations where id = v.reservation_id));
        if v_company is null then raise exception 'No company on this reservation to bill'; end if;
        insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description,
                                    amount, payment_method, business_date, posted_by, source)
        values (v.property_id, v_folio.id, p_stay, 'payment', 'payment', 'Transfer to city ledger',
                -v_bal, 'city_ledger', v_bd, auth.uid(), 'system');
        insert into pms_city_ledger(property_id, company_id, folio_id, entry_type, description, amount,
                                    business_date, posted_by)
        values (v.property_id, v_company, v_folio.id, 'invoice',
                'Folio #' || v_folio.folio_no, v_bal, v_bd, auth.uid());
      else
        raise exception 'Folio #% has a balance of %. Settle it before check-out.', v_folio.folio_no, v_bal;
      end if;
    end if;
    update pms_folios set status = 'closed', closed_at = now() where id = v_folio.id;
  end loop;

  update pms_stays set status = 'checked_out', checked_out_at = now(),
    departure = least(departure, greatest(v_bd, arrival + 1))
  where id = p_stay;
  update pms_rooms set hk_status = 'dirty' where id = v.room_id;
  perform pms__refresh_reservation(v.reservation_id);
  perform pms_log(v.property_id, 'stay.check_out', 'stay', p_stay, jsonb_build_object('room_id', v.room_id));
end $$;

-- ---------------------------------------------------------------------
-- Folio postings
-- ---------------------------------------------------------------------
create or replace function pms__open_folio(p_folio uuid) returns pms_folios
language plpgsql security definer set search_path = public as $$
declare f pms_folios;
begin
  select * into f from pms_folios where id = p_folio for update;
  if not found then raise exception 'Folio not found'; end if;
  if f.status <> 'open' then raise exception 'Folio #% is closed', f.folio_no; end if;
  return f;
end $$;

create or replace function pms__drawer(p_property uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select id from pms_drawer_sessions
  where property_id = p_property and user_id = auth.uid() and status = 'open'
$$;

create or replace function pms_post_charge(
  p_folio uuid, p_category text, p_description text, p_amount numeric, p_reference text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare f pms_folios; v_id uuid;
begin
  f := pms__open_folio(p_folio);
  perform pms_require(f.property_id, array['owner','manager','front_desk','accountant']);
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if p_category not in ('room','tax','fnb','laundry','minibar','transport','spa','extra_bed','damage','other') then
    raise exception 'Unknown charge category %', p_category;
  end if;
  insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount,
                              reference, business_date, posted_by)
  values (f.property_id, p_folio, f.stay_id, 'charge', p_category, p_description, round(p_amount,2),
          p_reference, (select business_date from pms_properties where id = f.property_id), auth.uid())
  returning id into v_id;
  perform pms_log(f.property_id, 'folio.charge', 'folio_line', v_id,
    jsonb_build_object('folio_no', f.folio_no, 'amount', p_amount, 'category', p_category));
  return v_id;
end $$;

create or replace function pms_post_payment(
  p_folio uuid, p_amount numeric, p_method text, p_reference text default null, p_refund boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare f pms_folios; v_id uuid; v_drawer uuid; v_bal numeric;
begin
  f := pms__open_folio(p_folio);
  perform pms_require(f.property_id, array['owner','manager','front_desk','accountant']);
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if p_method not in ('cash','mobile_money','card','bank','other') then raise exception 'Unknown payment method'; end if;
  if p_method in ('mobile_money','card','bank') and coalesce(trim(p_reference),'') = '' then
    raise exception 'A transaction reference is required for % payments', replace(p_method,'_',' ');
  end if;
  if p_method = 'cash' then
    v_drawer := pms__drawer(f.property_id);
    if v_drawer is null then raise exception 'Open your cash drawer before taking cash'; end if;
  end if;
  if p_refund then
    select balance into v_bal from pms_folio_balances where folio_id = p_folio;
    if -v_bal < p_amount then raise exception 'Refund is larger than the credit on this folio (%)', -v_bal; end if;
  end if;
  insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount,
                              payment_method, reference, business_date, drawer_session_id, posted_by)
  values (f.property_id, p_folio, f.stay_id,
          case when p_refund then 'refund' else 'payment' end, 'payment',
          case when p_refund then 'Refund' else 'Payment' end || ' — ' || replace(p_method,'_',' '),
          case when p_refund then round(p_amount,2) else -round(p_amount,2) end,
          p_method, p_reference, (select business_date from pms_properties where id = f.property_id),
          v_drawer, auth.uid())
  returning id into v_id;
  perform pms_log(f.property_id, case when p_refund then 'folio.refund' else 'folio.payment' end,
    'folio_line', v_id, jsonb_build_object('folio_no', f.folio_no, 'amount', p_amount, 'method', p_method));
  return v_id;
end $$;

create or replace function pms_post_discount(p_folio uuid, p_amount numeric, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare f pms_folios; v_id uuid;
begin
  f := pms__open_folio(p_folio);
  perform pms_require(f.property_id, array['owner','manager']);
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount,
                              business_date, posted_by)
  values (f.property_id, p_folio, f.stay_id, 'discount', 'discount', 'Discount — ' || p_reason,
          -round(p_amount,2), (select business_date from pms_properties where id = f.property_id), auth.uid())
  returning id into v_id;
  perform pms_log(f.property_id, 'folio.discount', 'folio_line', v_id,
    jsonb_build_object('folio_no', f.folio_no, 'amount', p_amount, 'reason', p_reason));
  return v_id;
end $$;

create or replace function pms_void_line(p_line uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare l pms_folio_lines; f pms_folios;
begin
  select * into l from pms_folio_lines where id = p_line for update;
  if not found then raise exception 'Line not found'; end if;
  f := pms__open_folio(l.folio_id);
  perform pms_require(l.property_id, array['owner','manager']);
  if l.voided then raise exception 'Already voided'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  if l.payment_method = 'city_ledger' then raise exception 'City ledger transfers cannot be voided here'; end if;
  if l.drawer_session_id is not null and exists (
    select 1 from pms_drawer_sessions where id = l.drawer_session_id and status = 'closed') then
    raise exception 'This cash was counted in a closed drawer. Post a refund instead.';
  end if;
  update pms_folio_lines set voided = true, void_reason = p_reason, voided_by = auth.uid(), voided_at = now()
  where id = p_line;
  perform pms_log(l.property_id, 'folio.void', 'folio_line', p_line,
    jsonb_build_object('folio_no', f.folio_no, 'amount', l.amount, 'description', l.description, 'reason', p_reason));
end $$;

-- Extra folio (e.g. separate company or personal bill)
create or replace function pms_add_folio(p_stay uuid, p_company uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v pms_stays; v_id uuid; v_guest uuid;
begin
  select * into v from pms_stays where id = p_stay;
  perform pms_require(v.property_id, array['owner','manager','front_desk']);
  if v.status not in ('tentative','confirmed','checked_in') then raise exception 'Stay is %', v.status; end if;
  select guest_id into v_guest from pms_reservations where id = v.reservation_id;
  insert into pms_folios(property_id, folio_no, reservation_id, stay_id, guest_id, company_id)
  values (v.property_id, pms__next_folio_no(v.property_id), v.reservation_id, p_stay, v_guest, p_company)
  returning id into v_id;
  return v_id;
end $$;

-- Move a charge to another open folio of the same reservation
create or replace function pms_transfer_line(p_line uuid, p_to_folio uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l pms_folio_lines; f_from pms_folios; f_to pms_folios;
begin
  select * into l from pms_folio_lines where id = p_line for update;
  if not found or l.voided then raise exception 'Line not found'; end if;
  f_from := pms__open_folio(l.folio_id);
  f_to := pms__open_folio(p_to_folio);
  perform pms_require(l.property_id, array['owner','manager','front_desk']);
  if f_from.reservation_id is distinct from f_to.reservation_id then
    raise exception 'Can only transfer between folios of the same reservation';
  end if;
  update pms_folio_lines set voided = true, void_reason = 'Transferred to folio #' || f_to.folio_no,
    voided_by = auth.uid(), voided_at = now() where id = p_line;
  insert into pms_folio_lines(property_id, folio_id, stay_id, line_type, category, description, amount,
    payment_method, reference, business_date, drawer_session_id, posted_by, source)
  values (l.property_id, p_to_folio, f_to.stay_id, l.line_type, l.category,
    l.description || ' (from folio #' || f_from.folio_no || ')', l.amount, l.payment_method, l.reference,
    l.business_date, l.drawer_session_id, auth.uid(), 'system');
  perform pms_log(l.property_id, 'folio.transfer', 'folio_line', p_line,
    jsonb_build_object('from', f_from.folio_no, 'to', f_to.folio_no, 'amount', l.amount));
end $$;

-- ---------------------------------------------------------------------
-- Cash drawer and expenses
-- ---------------------------------------------------------------------
create or replace function pms_open_drawer(p_property uuid, p_float numeric default 0) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform pms_require(p_property, array['owner','manager','front_desk','accountant']);
  if pms__drawer(p_property) is not null then raise exception 'You already have an open drawer'; end if;
  insert into pms_drawer_sessions(property_id, user_id, opening_float)
  values (p_property, auth.uid(), coalesce(p_float,0)) returning id into v_id;
  perform pms_log(p_property, 'drawer.open', 'drawer', v_id, jsonb_build_object('float', p_float));
  return v_id;
end $$;

create or replace function pms_drawer_expected(p_session uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select s.opening_float
       - coalesce((select sum(l.amount) from pms_folio_lines l
                   where l.drawer_session_id = s.id and not l.voided and l.payment_method = 'cash'), 0)
       + coalesce((select sum(c.amount) from pms_city_ledger c
                   where c.entry_type = 'payment' and c.payment_method = 'cash'
                     and c.reference = 'drawer:' || s.id::text), 0)
       - coalesce((select sum(e.amount) from pms_expense_vouchers e
                   where e.drawer_session_id = s.id), 0)
  from pms_drawer_sessions s where s.id = p_session
$$;

create or replace function pms_close_drawer(p_session uuid, p_counted numeric, p_notes text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s pms_drawer_sessions; v_exp numeric;
begin
  select * into s from pms_drawer_sessions where id = p_session for update;
  if not found or s.status <> 'open' then raise exception 'Drawer is not open'; end if;
  perform pms_require(s.property_id);
  if s.user_id <> auth.uid() and pms_role(s.property_id) not in ('owner','manager') then
    raise exception 'Only the cashier or a manager can close this drawer';
  end if;
  v_exp := pms_drawer_expected(p_session);
  update pms_drawer_sessions set status = 'closed', closed_at = now(), expected_cash = v_exp,
    counted_cash = p_counted, variance = p_counted - v_exp, notes = p_notes
  where id = p_session;
  perform pms_log(s.property_id, 'drawer.close', 'drawer', p_session,
    jsonb_build_object('expected', v_exp, 'counted', p_counted, 'variance', p_counted - v_exp));
  return jsonb_build_object('expected', v_exp, 'counted', p_counted, 'variance', p_counted - v_exp);
end $$;

create or replace function pms_add_expense(
  p_property uuid, p_category text, p_description text, p_amount numeric,
  p_method text default 'cash', p_paid_to text default null, p_reference text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_drawer uuid;
begin
  perform pms_require(p_property, array['owner','manager','front_desk','accountant']);
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if p_method = 'cash' then
    v_drawer := pms__drawer(p_property);
    if v_drawer is null then raise exception 'Open your cash drawer before paying cash out'; end if;
  end if;
  insert into pms_expense_vouchers(property_id, business_date, category, description, amount,
    payment_method, paid_to, reference, drawer_session_id, created_by)
  values (p_property, (select business_date from pms_properties where id = p_property), p_category,
    p_description, round(p_amount,2), p_method, p_paid_to, p_reference, v_drawer, auth.uid())
  returning id into v_id;
  perform pms_log(p_property, 'expense.add', 'expense', v_id, jsonb_build_object('amount', p_amount, 'category', p_category));
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- City ledger (company accounts)
-- ---------------------------------------------------------------------
create or replace function pms_city_ledger_payment(
  p_property uuid, p_company uuid, p_amount numeric, p_method text, p_reference text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_drawer uuid; v_ref text := p_reference;
begin
  perform pms_require(p_property, array['owner','manager','accountant','front_desk']);
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if p_method = 'cash' then
    v_drawer := pms__drawer(p_property);
    if v_drawer is null then raise exception 'Open your cash drawer before taking cash'; end if;
    v_ref := 'drawer:' || v_drawer::text;
  end if;
  insert into pms_city_ledger(property_id, company_id, entry_type, description, amount, payment_method,
                              reference, business_date, posted_by)
  values (p_property, p_company, 'payment', 'Payment received — ' || replace(p_method,'_',' '),
          -round(p_amount,2), p_method, v_ref,
          (select business_date from pms_properties where id = p_property), auth.uid())
  returning id into v_id;
  perform pms_log(p_property, 'city_ledger.payment', 'company', p_company, jsonb_build_object('amount', p_amount));
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------
create or replace function pms_set_room_status(p_room uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_prop uuid; v_old text;
begin
  select property_id, hk_status into v_prop, v_old from pms_rooms where id = p_room;
  if v_prop is null then raise exception 'Room not found'; end if;
  perform pms_require(v_prop, array['owner','manager','front_desk','housekeeping']);
  if p_status not in ('clean','dirty','inspected','out_of_order') then raise exception 'Unknown status'; end if;
  update pms_rooms set hk_status = p_status, hk_note = p_note where id = p_room;
  perform pms_log(v_prop, 'room.status', 'room', p_room, jsonb_build_object('from', v_old, 'to', p_status));
end $$;

create or replace function pms_block_room(p_room uuid, p_from date, p_to date, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_prop uuid; v_id uuid;
begin
  select property_id into v_prop from pms_rooms where id = p_room;
  if v_prop is null then raise exception 'Room not found'; end if;
  perform pms_require(v_prop, array['owner','manager']);
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  begin
    insert into pms_maintenance_blocks(property_id, room_id, from_date, to_date, reason, created_by)
    values (v_prop, p_room, p_from, p_to, p_reason, auth.uid()) returning id into v_id;
  exception when exclusion_violation then raise exception '%', pms__friendly(sqlerrm);
  end;
  perform pms_log(v_prop, 'room.block', 'room', p_room, jsonb_build_object('from', p_from, 'to', p_to, 'reason', p_reason));
  return v_id;
end $$;

create or replace function pms_release_block(p_block uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_prop uuid; v_room uuid;
begin
  select property_id, room_id into v_prop, v_room from pms_maintenance_blocks where id = p_block;
  if v_prop is null then raise exception 'Block not found'; end if;
  perform pms_require(v_prop, array['owner','manager']);
  update pms_maintenance_blocks set status = 'released' where id = p_block;
  perform pms_log(v_prop, 'room.release', 'room', v_room, null);
end $$;

grant execute on all functions in schema public to authenticated;
