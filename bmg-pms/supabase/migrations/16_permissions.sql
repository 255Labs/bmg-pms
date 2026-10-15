-- module: access
-- also: back-office, cashiering, core, front-office, integrations, operations, payments, reports, stock
-- =====================================================================
-- BMG PMS · 16 · Least privilege: every role sees and does exactly what its job needs
-- Before this, any member of a property (housekeeping, storekeeper) could read guest details,
-- folios, payments, reservation trails and revenue reports through the API, even though the
-- app hid those screens from them. Now the database matches the role matrix the app shows:
--
--   Front office money and guests (folios, payments, guests, reservations, stays, city ledger,
--   drawers, expenses, POS bills): owner, manager, front desk, accountant
--   Audit trail: owner, manager, accountant · Integration logs, door and camera data: owner, manager
--   Stock levels and value: owner, manager, accountant, storekeeper
--   Housekeeping, pool and gym attendants get two narrow lookups instead:
--   in-house guest names by room, and the last guests of a room they are checking.
-- Safe to re-run. Run after 15.
-- =====================================================================

do $$
declare t text; fo text := 'array[''owner'',''manager'',''front_desk'',''accountant'']';
begin
  foreach t in array array['pms_folio_lines','pms_folios','pms_city_ledger','pms_drawer_sessions','pms_expense_vouchers',
    'pms_payment_requests','pms_fiscal_receipts','pms_external_charges','pms_companies','pms_guests','pms_reservations','pms_stays',
    'pms_pos_bills','pms_guest_messages','pms_lost_found','pms_channex_revisions','pms_travel_agents','pms_sales_persons'] loop
    if to_regclass(t) is null then continue; end if;
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select using (property_id in (select pms_my_properties(%s)))', t || '_read', t, fo);
  end loop;
  foreach t in array array['pms_audit_log'] loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select using (property_id in (select pms_my_properties(array[''owner'',''manager'',''accountant''])))', t || '_read', t);
  end loop;
  foreach t in array array['pms_integration_log','pms_jobs','pms_door_events','pms_camera_events'] loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select using (property_id in (select pms_my_properties(array[''owner'',''manager''])))', t || '_read', t);
  end loop;
end $$;

-- POS bill lines follow their bill
drop policy if exists pms_pos_bill_items_read on pms_pos_bill_items;
create policy pms_pos_bill_items_read on pms_pos_bill_items for select
  using (exists (select 1 from pms_pos_bills b where b.id = pms_pos_bill_items.bill_id
                 and b.property_id in (select pms_my_properties(array['owner','manager','front_desk','accountant']))));

-- Guest messages and lost & found are worked by everyone (housekeeping takes messages and finds items),
-- but read through these two lists so housekeeping does not need the guest table
drop policy if exists pms_guest_messages_read on pms_guest_messages;
create policy pms_guest_messages_read on pms_guest_messages for select using (property_id in (select pms_my_properties(null::text[])));
drop policy if exists pms_lost_found_read on pms_lost_found;
create policy pms_lost_found_read on pms_lost_found for select using (property_id in (select pms_my_properties(null::text[])));

-- In-house guests by room, for the pool or gym door, guest messages and POS (names only, no money)
create or replace function pms_inhouse_guests(p_property uuid)
returns table(stay_id uuid, reservation_id uuid, room text, guest text, departure date)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','front_desk','accountant','housekeeping']);
  return query
    select s.id, s.reservation_id, r.number, g.first_name || coalesce(' ' || g.last_name, ''), s.departure
    from pms_stays s join pms_reservations res on res.id = s.reservation_id join pms_guests g on g.id = res.guest_id
    left join pms_rooms r on r.id = s.room_id
    where s.property_id = p_property and s.status = 'checked_in'
    order by r.number;
end $$;

-- The last guests of a room, for a room check after check-out (names and dates only)
create or replace function pms_room_recent_stays(p_room uuid)
returns table(stay_id uuid, status text, arrival date, departure date, res_no int, guest text)
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid;
begin
  select property_id into v_prop from pms_rooms where id = p_room;
  if v_prop is null then raise exception 'Room not found'; end if;
  perform pms_require(v_prop, array['owner','manager','front_desk','housekeeping','storekeeper']);
  return query
    select s.id, s.status, s.arrival, s.departure, res.res_no, g.first_name || coalesce(' ' || g.last_name, '')
    from pms_stays s join pms_reservations res on res.id = s.reservation_id join pms_guests g on g.id = res.guest_id
    where s.room_id = p_room and s.status in ('checked_in','checked_out')
    order by s.departure desc limit 4;
end $$;

-- pms_rpt_stays: was open to every member (from 05_reports.sql)
create or replace function pms_rpt_stays(p_property uuid, p_kind text, p_from date, p_to date)
returns table(stay_id uuid, reservation_id uuid, res_no int, guest text, phone text, company text, source text,
              room text, room_type text, arrival date, departure date, nights int, adults int, children int,
              rate numeric, status text, balance numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_bd date;
begin
  perform pms_require(p_property, array['owner','manager','front_desk','accountant']);
  select business_date into v_bd from pms_properties where id = p_property;
  return query
    select s.id, r.id, r.res_no, pms__guest_name(g), g.phone, c.name, bs.name, rm.number, rt.name,
           s.arrival, s.departure, (s.departure - s.arrival)::int, s.adults, s.children, s.rate, s.status,
           coalesce((select sum(b.balance) from pms_folios f join pms_folio_balances b on b.folio_id = f.id
                     where f.stay_id = s.id), 0)
    from pms_stays s
    join pms_reservations r on r.id = s.reservation_id
    join pms_guests g on g.id = r.guest_id
    join pms_room_types rt on rt.id = s.room_type_id
    left join pms_rooms rm on rm.id = s.room_id
    left join pms_companies c on c.id = r.company_id
    left join pms_business_sources bs on bs.id = r.source_id
    where s.property_id = p_property
      and case p_kind
            when 'arrivals'   then s.arrival between p_from and p_to and s.status <> 'cancelled'
            when 'departures' then s.departure between p_from and p_to and s.status in ('checked_in','checked_out','confirmed','tentative')
            when 'in_house'   then s.status = 'checked_in'
            when 'cancelled'  then s.status = 'cancelled' and s.arrival between p_from and p_to
            when 'no_show'    then s.status = 'no_show' and s.arrival between p_from and p_to
            else s.arrival <= p_to and s.departure > p_from
          end
    order by rm.number nulls last, r.res_no;
end $$;

-- pms_rpt_occupancy: was open to every member (from 05_reports.sql)
create or replace function pms_rpt_occupancy(p_property uuid, p_from date, p_to date)
returns table(stay_date date, rooms_available int, rooms_sold int, occupancy_pct numeric,
              room_revenue numeric, adr numeric, revpar numeric, is_forecast boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_bd date;
begin
  perform pms_require(p_property, array['owner','manager','front_desk','accountant']);
  select business_date into v_bd from pms_properties where id = p_property;
  return query
    with days as (select d::date as d from generate_series(p_from, p_to, interval '1 day') d),
    calc as (
      select days.d,
        (select count(*) from pms_rooms r where r.property_id = p_property and r.active
           and not exists (select 1 from pms_maintenance_blocks b where b.room_id = r.id and b.status = 'active'
                           and days.d >= b.from_date and days.d < b.to_date))::int as avail,
        (select count(*) from pms_stays s where s.property_id = p_property
           and s.status in ('confirmed','tentative','checked_in','checked_out')
           and days.d >= s.arrival and days.d < s.departure)::int as sold,
        case when days.d < v_bd then
          (select coalesce(sum(l.amount),0) from pms_folio_lines l where l.property_id = p_property
             and l.business_date = days.d and l.category = 'room' and not l.voided)
        else
          (select coalesce(sum(s.rate),0) from pms_stays s where s.property_id = p_property
             and s.status in ('confirmed','tentative','checked_in')
             and days.d >= s.arrival and days.d < s.departure)
        end as rev
      from days)
    select c.d, c.avail, c.sold,
      case when c.avail > 0 then round(c.sold * 100.0 / c.avail, 1) else 0 end,
      c.rev,
      case when c.sold > 0 then round(c.rev / c.sold, 2) else 0 end,
      case when c.avail > 0 then round(c.rev / c.avail, 2) else 0 end,
      c.d >= v_bd
    from calc c order by c.d;
end $$;

-- pms_availability: was open to every member (from 03_functions.sql)
create or replace function pms_availability(p_property uuid, p_from date, p_to date)
returns table(room_type_id uuid, room_type text, stay_date date, available integer, rate numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','front_desk','accountant']);
  return query
    select t.id, t.name, d::date, pms_type_availability(t.id, d::date), t.base_rate
    from pms_room_types t
    cross join generate_series(p_from, p_to - 1, interval '1 day') d
    where t.property_id = p_property and t.active
    order by t.sort_order, t.name, d;
end $$;

-- pms_free_rooms: was open to every member (from 03_functions.sql)
create or replace function pms_free_rooms(p_property uuid, p_arrival date, p_departure date, p_exclude_stay uuid default null)
returns table(room_id uuid, number text, room_type_id uuid, room_type text, hk_status text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','front_desk','accountant']);
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

-- pms_list_members: was open to every member (from 03_functions.sql)
create or replace function pms_list_members(p_property uuid)
returns table(user_id uuid, email text, display_name text, role text, active boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','front_desk','accountant']);
  return query
    select m.user_id, u.email::text, m.display_name, m.role, m.active
    from pms_members m join auth.users u on u.id = m.user_id
    where m.property_id = p_property order by m.role, u.email;
end $$;

-- pms_reservation_trail: was open to every member (from 15_operations.sql)
create or replace function pms_reservation_trail(p_reservation uuid)
returns table(at timestamptz, user_name text, action text, details jsonb, ip text)
language plpgsql stable security definer set search_path = public as $$
declare v_prop uuid;
begin
  select property_id into v_prop from pms_reservations where id = p_reservation;
  if v_prop is null then raise exception 'Reservation not found'; end if;
  perform pms_require(v_prop, array['owner','manager','front_desk','accountant']);
  return query
    select a.created_at, coalesce(m.display_name, u.email::text, 'system'), a.action, a.details, a.ip
    from pms_audit_log a
    left join pms_members m on m.property_id = a.property_id and m.user_id = a.user_id
    left join auth.users u on u.id = a.user_id
    where a.property_id = v_prop and (
      a.entity_id = p_reservation
      or a.entity_id in (select id from pms_stays where reservation_id = p_reservation)
      or a.entity_id in (select l.id from pms_folio_lines l join pms_folios f on f.id = l.folio_id where f.reservation_id = p_reservation))
    order by a.created_at desc;
end $$;

-- pms_rate_grid: was open to every member (from 15_operations.sql)
create or replace function pms_rate_grid(p_property uuid, p_from date, p_days int default 14)
returns table(room_type_id uuid, rate_plan_id uuid, rate_date date, amount numeric, own_rate boolean, extra_adult numeric, extra_child numeric,
              min_stay int, max_stay int, stop_sell boolean, cta boolean, ctd boolean, free int, sold int, total int, holiday text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','front_desk','accountant']);
  if p_days < 1 or p_days > 62 then raise exception 'Show between 1 and 62 days'; end if;
  return query
    select t.id, rp.id, d::date,
      pms__rate(t.id, rp.id, d::date), r.amount is not null,
      coalesce(r.extra_adult, t.extra_adult_rate), coalesce(r.extra_child, t.extra_child_rate),
      coalesce(x.min_stay, 1), x.max_stay, coalesce(x.stop_sell, false), coalesce(x.cta, false), coalesce(x.ctd, false),
      pms__free_of_type(t.id, d::date),
      (select count(*)::int from pms_stays s where s.room_type_id = t.id and s.status in ('tentative','confirmed','checked_in','checked_out')
         and d::date >= s.arrival and d::date < s.departure),
      (select count(*)::int from pms_rooms rm where rm.room_type_id = t.id and rm.active),
      (select h.name from pms_holidays h where h.property_id = p_property and h.holiday_date = d::date)
    from pms_room_types t
    cross join pms_rate_plans rp
    cross join generate_series(p_from, p_from + p_days - 1, interval '1 day') d
    left join pms_rates r on r.room_type_id = t.id and r.rate_plan_id = rp.id and r.rate_date = d::date
    left join pms_rate_restrictions x on x.room_type_id = t.id and x.rate_plan_id = rp.id and x.rate_date = d::date
    where t.property_id = p_property and rp.property_id = p_property and t.active and rp.active
    order by t.sort_order, t.name, rp.name, d;
end $$;

-- pms_rpt_stock_levels: was open to every member (from 11_stock_assets.sql)
create or replace function pms_rpt_stock_levels(p_property uuid)
returns table(item_id uuid, item text, category text, unit text, location_id uuid, location text, qty numeric,
              total_qty numeric, reorder_level numeric, avg_cost numeric, value numeric, low boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','accountant','storekeeper']);
  return query
    select i.id, i.name, i.category, i.unit, l.id, l.name, coalesce(s.qty, 0)::numeric,
           coalesce(sum(coalesce(s.qty, 0)) over (partition by i.id), 0)::numeric, i.reorder_level, i.avg_cost,
           round(coalesce(s.qty, 0) * i.avg_cost, 2),
           coalesce(sum(coalesce(s.qty, 0)) over (partition by i.id), 0) <= i.reorder_level and i.reorder_level > 0
      from pms_stock_items i
      cross join pms_stock_locations l
      left join pms_stock_levels s on s.item_id = i.id and s.location_id = l.id
     where i.property_id = p_property and l.property_id = p_property and i.active and l.active
     order by i.name, l.name;
end $$;

-- Same lockdown as 13 and 15 for anything new
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as fn from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname not like 'pms\_public\_%' loop
    execute format('revoke execute on function %s from public, anon', r.fn);
  end loop;
end $$;
grant execute on function pms_inhouse_guests(uuid), pms_room_recent_stays(uuid), pms_rpt_stays(uuid, text, date, date),
  pms_rpt_occupancy(uuid, date, date), pms_availability(uuid, date, date), pms_list_members(uuid),
  pms_reservation_trail(uuid), pms_rate_grid(uuid, date, int), pms_rpt_stock_levels(uuid) to authenticated;
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;
notify pgrst, 'reload schema';

-- Only owners and managers put a guest on (or take them off) the blacklist
create or replace function pms__guard_guest() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.blacklisted is distinct from old.blacklisted or new.blacklist_reason is distinct from old.blacklist_reason)
     and auth.uid() is not null and coalesce(pms_role(new.property_id), '') not in ('owner','manager') then
    raise exception 'Only a manager can change the blacklist';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_guest on pms_guests;
create trigger trg_guard_guest before update on pms_guests for each row execute function pms__guard_guest();
revoke execute on function pms__guard_guest() from public, anon, authenticated;

-- Group overview: every member sees their properties' room counts, but money (revenue, open balances)
-- only for the roles that see reports. Properties needing two-step sign-in stay hidden until it is on.
create or replace function pms_group_snapshot()
returns table(property_id uuid, property text, role text, business_date date, rooms int, in_house int,
              arrivals int, departures int, occupancy_pct numeric, revenue_last_audit numeric,
              open_balance numeric, dirty_rooms int)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, m.role, p.business_date,
    (select count(*) from pms_rooms r where r.property_id = p.id and r.active)::int,
    (select count(*) from pms_stays s where s.property_id = p.id and s.status = 'checked_in')::int,
    (select count(*) from pms_stays s where s.property_id = p.id and s.arrival = p.business_date
       and s.status in ('confirmed','tentative'))::int,
    (select count(*) from pms_stays s where s.property_id = p.id and s.departure = p.business_date
       and s.status = 'checked_in')::int,
    coalesce((select na.occupancy_pct from pms_night_audits na where na.property_id = p.id
       order by na.business_date desc limit 1), 0),
    case when m.role in ('owner','manager','front_desk','accountant') then
      coalesce((select na.room_revenue + na.tax_revenue + na.other_revenue from pms_night_audits na
        where na.property_id = p.id order by na.business_date desc limit 1), 0) end,
    case when m.role in ('owner','manager','front_desk','accountant') then
      coalesce((select sum(b.balance) from pms_folio_balances b join pms_folios f on f.id = b.folio_id
        where f.property_id = p.id and f.status = 'open'), 0) end,
    (select count(*) from pms_rooms r where r.property_id = p.id and r.hk_status = 'dirty')::int
  from pms_properties p join pms_members m on m.property_id = p.id
  where m.user_id = auth.uid() and m.active and p.id in (select pms_my_properties())
  order by p.name
$$;
revoke execute on function pms_group_snapshot() from public, anon;
grant execute on function pms_group_snapshot() to authenticated;
