-- module: reports
-- =====================================================================
-- BMG PMS — 05 REPORTS
-- Every report is a function so the numbers come from one place and
-- membership is checked once.
-- =====================================================================

create or replace function pms__guest_name(g pms_guests) returns text language sql immutable as $$
  select trim(coalesce(g.title || ' ', '') || g.first_name || ' ' || coalesce(g.last_name, ''))
$$;

-- Arrivals / departures / in-house share one shape
create or replace function pms_rpt_stays(p_property uuid, p_kind text, p_from date, p_to date)
returns table(stay_id uuid, reservation_id uuid, res_no int, guest text, phone text, company text, source text,
              room text, room_type text, arrival date, departure date, nights int, adults int, children int,
              rate numeric, status text, balance numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_bd date;
begin
  perform pms_require(p_property);
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

create or replace function pms_rpt_daily_revenue(p_property uuid, p_from date, p_to date)
returns table(business_date date, room numeric, tax numeric, fnb numeric, other numeric, discounts numeric,
              total_revenue numeric, payments numeric, city_ledger numeric, expenses numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','accountant','front_desk']);
  return query
    select d::date,
      coalesce(sum(l.amount) filter (where l.category = 'room'), 0),
      coalesce(sum(l.amount) filter (where l.category = 'tax'), 0),
      coalesce(sum(l.amount) filter (where l.category = 'fnb'), 0),
      coalesce(sum(l.amount) filter (where l.line_type = 'charge' and l.category not in ('room','tax','fnb')), 0),
      coalesce(sum(l.amount) filter (where l.line_type = 'discount'), 0),
      coalesce(sum(l.amount) filter (where l.line_type in ('charge','discount')), 0),
      coalesce(-sum(l.amount) filter (where l.line_type in ('payment','refund') and l.payment_method <> 'city_ledger'), 0),
      coalesce(-sum(l.amount) filter (where l.payment_method = 'city_ledger'), 0),
      (select coalesce(sum(e.amount), 0) from pms_expense_vouchers e
        where e.property_id = p_property and e.business_date = d::date)
    from generate_series(p_from, p_to, interval '1 day') d
    left join pms_folio_lines l on l.property_id = p_property and l.business_date = d::date and not l.voided
    group by d order by d;
end $$;

create or replace function pms_rpt_payments(p_property uuid, p_from date, p_to date)
returns table(posted_at timestamptz, business_date date, folio_no int, res_no int, guest text, method text,
              amount numeric, reference text, cashier text, voided boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','accountant','front_desk']);
  return query
    select l.created_at, l.business_date, f.folio_no, r.res_no, pms__guest_name(g), l.payment_method,
           -l.amount, l.reference, coalesce(m.display_name, u.email::text), l.voided
    from pms_folio_lines l
    join pms_folios f on f.id = l.folio_id
    left join pms_reservations r on r.id = f.reservation_id
    left join pms_guests g on g.id = r.guest_id
    left join pms_members m on m.property_id = l.property_id and m.user_id = l.posted_by
    left join auth.users u on u.id = l.posted_by
    where l.property_id = p_property and l.line_type in ('payment','refund')
      and l.payment_method <> 'city_ledger' and l.business_date between p_from and p_to
    order by l.created_at;
end $$;

create or replace function pms_rpt_occupancy(p_property uuid, p_from date, p_to date)
returns table(stay_date date, rooms_available int, rooms_sold int, occupancy_pct numeric,
              room_revenue numeric, adr numeric, revpar numeric, is_forecast boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_bd date;
begin
  perform pms_require(p_property);
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

-- Ageing debtors: company balances bucketed by invoice age, payments applied oldest first
create or replace function pms_rpt_ageing(p_property uuid)
returns table(company_id uuid, company text, phone text, credit_limit numeric, balance numeric,
              d0_30 numeric, d31_60 numeric, d61_90 numeric, d90_plus numeric, oldest_invoice date)
language plpgsql stable security definer set search_path = public as $$
declare v_bd date;
begin
  perform pms_require(p_property, array['owner','manager','accountant','front_desk']);
  select business_date into v_bd from pms_properties where id = p_property;
  return query
    with paid as (
      select cl.company_id, coalesce(-sum(cl.amount), 0) as total_paid
      from pms_city_ledger cl where cl.property_id = p_property and cl.entry_type = 'payment'
      group by cl.company_id),
    inv as (
      select cl.company_id, cl.business_date, cl.amount,
        sum(cl.amount) over (partition by cl.company_id order by cl.business_date, cl.created_at) as cum
      from pms_city_ledger cl where cl.property_id = p_property and cl.entry_type = 'invoice'),
    open_inv as (
      select i.company_id, i.business_date,
        greatest(0, i.cum - greatest(coalesce(p.total_paid,0), i.cum - i.amount)) as open_amt
      from inv i left join paid p on p.company_id = i.company_id)
    select c.id, c.name, c.phone, c.credit_limit,
      (select coalesce(sum(cl.amount),0) from pms_city_ledger cl
        where cl.company_id = c.id and cl.property_id = p_property),
      coalesce(sum(o.open_amt) filter (where v_bd - o.business_date <= 30), 0),
      coalesce(sum(o.open_amt) filter (where v_bd - o.business_date between 31 and 60), 0),
      coalesce(sum(o.open_amt) filter (where v_bd - o.business_date between 61 and 90), 0),
      coalesce(sum(o.open_amt) filter (where v_bd - o.business_date > 90), 0),
      min(o.business_date) filter (where o.open_amt > 0)
    from pms_companies c
    left join open_inv o on o.company_id = c.id
    where c.property_id = p_property
    group by c.id, c.name, c.phone, c.credit_limit
    having exists (select 1 from pms_city_ledger cl where cl.company_id = c.id)
    order by 5 desc;
end $$;

create or replace function pms_rpt_cashier(p_property uuid, p_from date, p_to date)
returns table(cashier text, method text, receipts numeric, refunds numeric, net numeric, transactions int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','accountant','front_desk']);
  return query
    select coalesce(m.display_name, u.email::text, 'system'), l.payment_method,
      coalesce(-sum(l.amount) filter (where l.line_type = 'payment'), 0),
      coalesce(sum(l.amount) filter (where l.line_type = 'refund'), 0),
      coalesce(-sum(l.amount), 0), count(*)::int
    from pms_folio_lines l
    left join pms_members m on m.property_id = l.property_id and m.user_id = l.posted_by
    left join auth.users u on u.id = l.posted_by
    where l.property_id = p_property and not l.voided and l.line_type in ('payment','refund')
      and l.payment_method <> 'city_ledger' and l.business_date between p_from and p_to
    group by 1, 2 order by 1, 2;
end $$;

create or replace function pms_rpt_house_status(p_property uuid)
returns table(room_id uuid, number text, room_type text, hk_status text, occupancy text,
              guest text, departure date, blocked_reason text, hk_note text)
language plpgsql stable security definer set search_path = public as $$
declare v_bd date;
begin
  perform pms_require(p_property);
  select business_date into v_bd from pms_properties where id = p_property;
  return query
    select r.id, r.number, t.name, r.hk_status,
      case when ih.id is not null then case when ih.departure = v_bd then 'due_out' else 'occupied' end
           when arr.id is not null then 'arriving'
           when b.id is not null then 'blocked'
           else 'vacant' end,
      coalesce(ih.guest, arr.guest), ih.departure, b.reason, r.hk_note
    from pms_rooms r join pms_room_types t on t.id = r.room_type_id
    left join lateral (select s.id, s.departure, pms__guest_name(g) as guest from pms_stays s
       join pms_reservations rs on rs.id = s.reservation_id join pms_guests g on g.id = rs.guest_id
       where s.room_id = r.id and s.status = 'checked_in' limit 1) ih on true
    left join lateral (select s.id, pms__guest_name(g) as guest from pms_stays s
       join pms_reservations rs on rs.id = s.reservation_id join pms_guests g on g.id = rs.guest_id
       where s.room_id = r.id and s.status in ('confirmed','tentative') and s.arrival = v_bd limit 1) arr on true
    left join lateral (select b.id, b.reason from pms_maintenance_blocks b where b.room_id = r.id
       and b.status = 'active' and v_bd >= b.from_date and v_bd < b.to_date limit 1) b on true
    where r.property_id = p_property and r.active
    order by t.sort_order, r.number;
end $$;

create or replace function pms_rpt_audit_trail(p_property uuid, p_from date, p_to date)
returns table(at timestamptz, user_name text, action text, entity text, details jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','accountant']);
  return query
    select a.created_at, coalesce(m.display_name, u.email::text, 'system'), a.action, a.entity, a.details
    from pms_audit_log a
    left join pms_members m on m.property_id = a.property_id and m.user_id = a.user_id
    left join auth.users u on u.id = a.user_id
    where a.property_id = p_property and a.created_at::date between p_from and p_to
    order by a.created_at desc limit 2000;
end $$;

create or replace function pms_rpt_voids(p_property uuid, p_from date, p_to date)
returns table(voided_at timestamptz, folio_no int, description text, amount numeric, reason text, voided_by text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms_require(p_property, array['owner','manager','accountant']);
  return query
    select l.voided_at, f.folio_no, l.description, l.amount, l.void_reason,
      coalesce(m.display_name, u.email::text)
    from pms_folio_lines l join pms_folios f on f.id = l.folio_id
    left join pms_members m on m.property_id = l.property_id and m.user_id = l.voided_by
    left join auth.users u on u.id = l.voided_by
    where l.property_id = p_property and l.voided and l.voided_at::date between p_from and p_to
      and coalesce(l.void_reason,'') not like 'Transferred to folio%'
    order by l.voided_at desc;
end $$;

-- Group dashboard: one row per property the signed-in user belongs to
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
    coalesce((select na.room_revenue + na.tax_revenue + na.other_revenue from pms_night_audits na
       where na.property_id = p.id order by na.business_date desc limit 1), 0),
    coalesce((select sum(b.balance) from pms_folio_balances b join pms_folios f on f.id = b.folio_id
       where f.property_id = p.id and f.status = 'open'), 0),
    (select count(*) from pms_rooms r where r.property_id = p.id and r.hk_status = 'dirty')::int
  from pms_properties p join pms_members m on m.property_id = p.id
  where m.user_id = auth.uid() and m.active
  order by p.name
$$;

-- ---------------------------------------------------------------------
-- Lock down internal helpers
-- ---------------------------------------------------------------------
revoke execute on function pms__next_folio_no(uuid) from public, authenticated;
revoke execute on function pms__refresh_reservation(uuid) from public, authenticated;
revoke execute on function pms__stay(uuid) from public, authenticated;
revoke execute on function pms__open_folio(uuid) from public, authenticated;
revoke execute on function pms_log(uuid, text, text, uuid, jsonb) from public, authenticated;

grant execute on function pms_rpt_stays(uuid, text, date, date) to authenticated;
grant execute on function pms_rpt_daily_revenue(uuid, date, date) to authenticated;
grant execute on function pms_rpt_payments(uuid, date, date) to authenticated;
grant execute on function pms_rpt_occupancy(uuid, date, date) to authenticated;
grant execute on function pms_rpt_ageing(uuid) to authenticated;
grant execute on function pms_rpt_cashier(uuid, date, date) to authenticated;
grant execute on function pms_rpt_house_status(uuid) to authenticated;
grant execute on function pms_rpt_audit_trail(uuid, date, date) to authenticated;
grant execute on function pms_rpt_voids(uuid, date, date) to authenticated;
grant execute on function pms_group_snapshot() to authenticated;

notify pgrst, 'reload schema';
